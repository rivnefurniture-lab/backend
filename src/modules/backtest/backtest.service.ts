// src/modules/backtest/backtest.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RunBacktestDto, StrategyCondition } from './dto/backtest.dto';
import { PrismaService } from '../../prisma/prisma.service';
import * as ccxt from 'ccxt';

export interface IndicatorProof {
  indicator: string;
  value: number;
  condition: string;
  target: number;
  triggered: boolean;
  timeframe: string;
}

export interface TradeEvent {
  timestamp: Date;
  date: string;
  time: string;
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  amount: number;
  total_amount: number;
  profit_percent: number;
  profit_usd: number;
  move_from_entry: number;
  trade_id: string;
  reason: string;
  indicatorProof: IndicatorProof[];
  equity: number;
  drawdown: number;
  comment: string;
  market_state: string;
}

export interface BacktestMetrics {
  net_profit: number;
  net_profit_usd: string;
  total_profit: number;
  total_profit_usd: string;
  max_drawdown: number;
  max_realized_drawdown: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  win_rate: number;
  total_trades: number;
  profit_factor: number | string;
  avg_profit_per_trade: number;
  yearly_return: number;
  exposure_time_frac: number;
}

export interface YearlyPerformance {
  year: number;
  net_profit: number;
  net_profit_usd: string;
  total_trades: number;
  win_rate: number;
  max_drawdown: number;
}

interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Position {
  symbol: string;
  entryPrice: number;
  entryTime: Date;
  quantity: number;
  tradeId: number;
  entryIndicators: IndicatorProof[];
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private exchange: ccxt.Exchange;
  
  // Simple in-memory cache for fetched data
  private dataCache: Map<string, OHLCV[]> = new Map();

  // Predefined strategy templates
  private readonly strategyTemplates: Record<string, {
    name: string;
    description: string;
    category: string;
    pairs: string[];
    entry_conditions: StrategyCondition[];
    exit_conditions: StrategyCondition[];
    take_profit?: number;
    stop_loss?: number;
  }> = {
    'rsi-ma-bb-golden': {
      name: 'RSI+MA+BB Golden Strategy',
      description: 'Proven strategy with 148% yearly return. RSI > 70 on 15m + SMA 50/200 on 1h, exits on BB%B < 0.1 on 4h.',
      category: 'Multi-Indicator / Trend & Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 28, Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 70 } },
        { indicator: 'MA', subfields: { 'MA Type': 'SMA', 'Fast MA': 50, 'Slow MA': 200, Condition: 'Greater Than', Timeframe: '1h' } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Less Than', Timeframe: '1h', 'Signal Value': 0.2 } }
      ]
    },
    'rsi-oversold-scalper': {
      name: 'RSI Oversold Scalper',
      description: 'Buys when RSI < 30, sells when RSI > 70. Quick mean reversion trades.',
      category: 'Scalping / Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '1h', Condition: 'Less Than', 'Signal Value': 30 } }
      ],
      exit_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 70 } }
      ],
      take_profit: 5,
      stop_loss: 3
    },
    'macd-trend-follower': {
      name: 'MACD Trend Follower',
      description: 'Follows MACD crossovers on 4h timeframe. Catches medium-term trends.',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT'],
      entry_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '4h', 'MACD Trigger': 'Crossing Up', 'Line Trigger': 'Greater Than 0' } }
      ],
      exit_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '4h', 'MACD Trigger': 'Crossing Down' } }
      ]
    },
    'bb-squeeze-breakout': {
      name: 'Bollinger Squeeze Breakout',
      description: 'Enters when price breaks above upper BB. Uses tight stop loss.',
      category: 'Volatility Breakout',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Greater Than', Timeframe: '1h', 'Signal Value': 1.0 } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Less Than', Timeframe: '1h', 'Signal Value': 0.5 } }
      ],
      take_profit: 5,
      stop_loss: 2
    },
    'dual-ma-crossover': {
      name: 'Dual MA Crossover',
      description: 'Classic EMA 20/50 crossover strategy on 4h timeframe.',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'MA', subfields: { 'MA Type': 'EMA', 'Fast MA': 20, 'Slow MA': 50, Condition: 'Crossing Up', Timeframe: '4h' } }
      ],
      exit_conditions: [
        { indicator: 'MA', subfields: { 'MA Type': 'EMA', 'Fast MA': 20, 'Slow MA': 50, Condition: 'Crossing Down', Timeframe: '4h' } }
      ]
    }
  };

  // Cache for preset strategy metrics
  private presetMetricsCache: Map<string, { 
    metrics: BacktestMetrics; 
    yearlyPerformance: YearlyPerformance[];
    calculatedAt: Date 
  }> = new Map();

  constructor(private readonly prisma: PrismaService) {
    this.exchange = new ccxt.binance({ enableRateLimit: true });
  }

  getStrategyTemplates() {
    return Object.entries(this.strategyTemplates).map(([id, template]) => ({
      id,
      ...template
    }));
  }

  // Get preset strategies with cached metrics
  async getPresetStrategiesWithMetrics() {
    const strategies: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      pairs: string[];
      config: Record<string, unknown>;
      cagr: number;
      sharpe: number;
      maxDD: number;
      winRate: number;
      totalTrades: number;
      returns: { daily: string; weekly: string; monthly: string; yearly: number };
      yearlyPerformance: YearlyPerformance[];
      isRealData: boolean;
      isPreset: boolean;
      updatedAt: string | null;
      needsCalculation: boolean;
    }> = [];
    
    for (const [id, template] of Object.entries(this.strategyTemplates)) {
      const cached = this.presetMetricsCache.get(id);
      const isFresh = !!(cached && (Date.now() - cached.calculatedAt.getTime()) < 60 * 60 * 1000);
      
      const metrics = isFresh ? cached.metrics : null;
      const yearlyPerformance = isFresh ? cached.yearlyPerformance : [];
      const cagr = metrics?.yearly_return || metrics?.net_profit || 0;
      
      strategies.push({
        id,
        name: template.name,
        description: template.description,
        category: template.category,
        pairs: template.pairs,
        config: {
          entry_conditions: template.entry_conditions,
          exit_conditions: template.exit_conditions,
          take_profit: template.take_profit,
          stop_loss: template.stop_loss,
        },
        cagr,
        sharpe: metrics?.sharpe_ratio || 0,
        maxDD: metrics?.max_drawdown || 0,
        winRate: metrics?.win_rate || 0,
        totalTrades: metrics?.total_trades || 0,
        returns: {
          daily: (cagr / 365).toFixed(3),
          weekly: (cagr / 52).toFixed(2),
          monthly: (cagr / 12).toFixed(1),
          yearly: cagr,
        },
        yearlyPerformance,
        isRealData: isFresh,
        isPreset: true,
        updatedAt: isFresh ? cached.calculatedAt.toISOString() : null,
        needsCalculation: !isFresh,
      });
    }
    
    return strategies;
  }

  // Calculate real metrics for a preset strategy
  async calculatePresetStrategyMetrics(strategyId: string): Promise<{
    id: string;
    name: string;
    metrics: BacktestMetrics | null;
    yearlyPerformance: YearlyPerformance[];
    error?: string;
  }> {
    const template = this.strategyTemplates[strategyId];
    
    if (!template) {
      return { id: strategyId, name: 'Unknown', metrics: null, yearlyPerformance: [], error: 'Strategy not found' };
    }
    
    try {
      this.logger.log(`Calculating real metrics for: ${strategyId}`);
      
      // Run backtest for last year
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 1);
      
      const result = await this.runBacktest({
        strategy_name: template.name,
        pairs: template.pairs.slice(0, 3), // Limit to 3 pairs for speed
        initial_balance: 5000,
        base_order_size: 1000,
        max_active_deals: 3,
        entry_conditions: template.entry_conditions,
        exit_conditions: template.exit_conditions,
        take_profit: template.take_profit,
        stop_loss: template.stop_loss,
        start_date: startDate.toISOString(),
        end_date: new Date().toISOString(),
      });
      
      if (result.status === 'success' && result.metrics) {
        // Cache the results
        this.presetMetricsCache.set(strategyId, {
          metrics: result.metrics,
          yearlyPerformance: [],
          calculatedAt: new Date(),
        });
        
        return {
          id: strategyId,
          name: template.name,
          metrics: result.metrics,
          yearlyPerformance: [],
        };
      }
      
      return {
        id: strategyId,
        name: template.name,
        metrics: null,
        yearlyPerformance: [],
        error: result.message,
      };
    } catch (error) {
      this.logger.error(`Failed to calculate metrics for ${strategyId}: ${error.message}`);
      return {
        id: strategyId,
        name: template.name,
        metrics: null,
        yearlyPerformance: [],
        error: error.message,
      };
    }
  }

  getAvailableIndicators() {
    return [
      {
        id: 'RSI',
        name: 'Relative Strength Index',
        params: [
          { key: 'RSI Length', type: 'number', default: 14, min: 2, max: 100 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Less Than' },
          { key: 'Signal Value', type: 'number', default: 30, min: 0, max: 100 }
        ]
      },
      {
        id: 'MA',
        name: 'Moving Average',
        params: [
          { key: 'MA Type', type: 'select', options: ['SMA', 'EMA'], default: 'SMA' },
          { key: 'Fast MA', type: 'number', default: 20, min: 1, max: 500 },
          { key: 'Slow MA', type: 'number', default: 50, min: 1, max: 500 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '4h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Crossing Up' }
        ]
      },
      {
        id: 'MACD',
        name: 'MACD',
        params: [
          { key: 'MACD Preset', type: 'select', options: ['12,26,9', '8,17,9', '5,35,5'], default: '12,26,9' },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '4h' },
          { key: 'MACD Trigger', type: 'select', options: ['Crossing Up', 'Crossing Down'], default: 'Crossing Up' },
          { key: 'Line Trigger', type: 'select', options: ['', 'Less Than 0', 'Greater Than 0'], default: '' }
        ]
      },
      {
        id: 'BollingerBands',
        name: 'Bollinger Bands %B',
        params: [
          { key: 'BB% Period', type: 'number', default: 20, min: 5, max: 100 },
          { key: 'Deviation', type: 'number', default: 2, min: 0.5, max: 5 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Less Than' },
          { key: 'Signal Value', type: 'number', default: 0, min: -1, max: 2 }
        ]
      }
    ];
  }

  // Fetch historical data from Binance (with caching)
  private async fetchHistoricalData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<OHLCV[]> {
    const cacheKey = `${symbol}_${timeframe}_${startDate.toISOString().split('T')[0]}`;
    
    // Check cache first
    if (this.dataCache.has(cacheKey)) {
      this.logger.log(`Using cached data for ${symbol} ${timeframe}`);
      return this.dataCache.get(cacheKey)!;
    }
    
    this.logger.log(`Fetching ${symbol} ${timeframe} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    const allData: OHLCV[] = [];
    let currentSince = startDate.getTime();
    const limit = 1000;
    
    try {
      while (currentSince < endDate.getTime()) {
        const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, currentSince, limit);
        
        if (!ohlcv || ohlcv.length === 0) break;
        
        for (const candle of ohlcv) {
          const timestamp = new Date(candle[0] as number);
          if (timestamp > endDate) break;
          
          allData.push({
            timestamp,
            open: candle[1] as number,
            high: candle[2] as number,
            low: candle[3] as number,
            close: candle[4] as number,
            volume: candle[5] as number,
          });
        }
        
        const lastTimestamp = ohlcv[ohlcv.length - 1][0] as number;
        if (lastTimestamp <= currentSince) break;
        currentSince = lastTimestamp + 1;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Cache the data
      if (allData.length > 0) {
        this.dataCache.set(cacheKey, allData);
      }
      
      this.logger.log(`Fetched ${allData.length} candles for ${symbol} ${timeframe}`);
      return allData;
    } catch (error) {
      this.logger.error(`Failed to fetch ${symbol}: ${error.message}`);
      return [];
    }
  }

  // ============ INDICATOR CALCULATIONS ============
  
  private calculateRSI(closes: number[], period: number): number[] {
    if (closes.length < period + 1) return new Array(closes.length).fill(NaN);
    
    const rsi: number[] = new Array(period).fill(NaN);
    let gains = 0, losses = 0;
    
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-9)));
    
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
      rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-9)));
    }
    
    return rsi;
  }

  private calculateSMA(values: number[], period: number): number[] {
    const sma: number[] = new Array(period - 1).fill(NaN);
    for (let i = period - 1; i < values.length; i++) {
      sma.push(values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return sma;
  }

  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) return new Array(values.length).fill(NaN);
    
    const ema: number[] = new Array(period - 1).fill(NaN);
    const multiplier = 2 / (period + 1);
    
    ema.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
    
    for (let i = period; i < values.length; i++) {
      ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    
    return ema;
  }

  private calculateMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
    const emaFast = this.calculateEMA(closes, fast);
    const emaSlow = this.calculateEMA(closes, slow);
    
    const macdLine = emaFast.map((f, i) => 
      isNaN(f) || isNaN(emaSlow[i]) ? NaN : f - emaSlow[i]
    );
    
    const validMacd = macdLine.filter(v => !isNaN(v));
    const signalValues = this.calculateEMA(validMacd, signal);
    
    const signalLine: number[] = new Array(macdLine.length - validMacd.length).fill(NaN);
    signalLine.push(...signalValues);
    
    return { macdLine, signalLine };
  }

  private calculateBollingerBands(closes: number[], period = 20, deviation = 2): number[] {
    const sma = this.calculateSMA(closes, period);
    const bbPercent: number[] = new Array(period - 1).fill(NaN);
    
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = sma[i];
      const stdDev = Math.sqrt(slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period);
      
      const upper = mean + deviation * stdDev;
      const lower = mean - deviation * stdDev;
      bbPercent.push((closes[i] - lower) / ((upper - lower) || 1));
    }
    
    return bbPercent;
  }

  // Check condition at index
  private checkCondition(
    closes: number[],
    index: number,
    conditions: StrategyCondition[]
  ): { passed: boolean; proofs: IndicatorProof[] } {
    if (!conditions || conditions.length === 0) return { passed: false, proofs: [] };
    
    const proofs: IndicatorProof[] = [];
    
    for (const cond of conditions) {
      const subfields = cond.subfields || {};
      const condition = subfields.Condition || subfields['MACD Trigger'];
      const targetValue = parseFloat(String(subfields['Signal Value'] ?? 0));
      const timeframe = subfields.Timeframe || '1h';
      
      let currentValue = NaN, prevValue = NaN;
      let compareValue: number | undefined;
      let prevCompareValue: number | undefined;
      let indicatorName = cond.indicator;
      
      switch (cond.indicator) {
        case 'RSI': {
          const period = parseInt(String(subfields['RSI Length'] || 14));
          const rsi = this.calculateRSI(closes.slice(0, index + 1), period);
          currentValue = rsi[rsi.length - 1];
          prevValue = rsi.length > 1 ? rsi[rsi.length - 2] : NaN;
          indicatorName = `RSI(${period})`;
          break;
        }
        case 'MA': {
          const fastPeriod = parseInt(String(subfields['Fast MA'] || 20));
          const slowPeriod = parseInt(String(subfields['Slow MA'] || 50));
          const maType = subfields['MA Type'] || 'SMA';
          const slice = closes.slice(0, index + 1);
          
          const fast = maType === 'EMA' ? this.calculateEMA(slice, fastPeriod) : this.calculateSMA(slice, fastPeriod);
          const slow = maType === 'EMA' ? this.calculateEMA(slice, slowPeriod) : this.calculateSMA(slice, slowPeriod);
          
          currentValue = fast[fast.length - 1];
          prevValue = fast.length > 1 ? fast[fast.length - 2] : NaN;
          compareValue = slow[slow.length - 1];
          prevCompareValue = slow.length > 1 ? slow[slow.length - 2] : NaN;
          indicatorName = `${maType}(${fastPeriod}/${slowPeriod})`;
          break;
        }
        case 'MACD': {
          const preset = String(subfields['MACD Preset'] || '12,26,9');
          const [f, s, sig] = preset.split(',').map(Number);
          const macd = this.calculateMACD(closes.slice(0, index + 1), f, s, sig);
          
          currentValue = macd.macdLine[macd.macdLine.length - 1];
          prevValue = macd.macdLine.length > 1 ? macd.macdLine[macd.macdLine.length - 2] : NaN;
          compareValue = macd.signalLine[macd.signalLine.length - 1];
          prevCompareValue = macd.signalLine.length > 1 ? macd.signalLine[macd.signalLine.length - 2] : NaN;
          
          const lineTrigger = subfields['Line Trigger'];
          if (lineTrigger === 'Greater Than 0' && currentValue <= 0) return { passed: false, proofs };
          if (lineTrigger === 'Less Than 0' && currentValue >= 0) return { passed: false, proofs };
          
          indicatorName = `MACD(${preset})`;
          break;
        }
        case 'BollingerBands': {
          const period = parseInt(String(subfields['BB% Period'] || 20));
          const deviation = parseFloat(String(subfields['Deviation'] || 2));
          const bb = this.calculateBollingerBands(closes.slice(0, index + 1), period, deviation);
          
          currentValue = bb[bb.length - 1];
          prevValue = bb.length > 1 ? bb[bb.length - 2] : NaN;
          indicatorName = `BB%B(${period},${deviation})`;
          break;
        }
      }
      
      if (isNaN(currentValue)) return { passed: false, proofs };
      
      let triggered = false;
      let displayTarget = targetValue;
      
      if (compareValue !== undefined) {
        displayTarget = compareValue;
        switch (condition) {
          case 'Less Than': triggered = currentValue < compareValue; break;
          case 'Greater Than': triggered = currentValue > compareValue; break;
          case 'Crossing Up': 
            triggered = !isNaN(prevValue) && !isNaN(prevCompareValue!) && 
                       prevValue <= prevCompareValue! && currentValue > compareValue;
            break;
          case 'Crossing Down':
            triggered = !isNaN(prevValue) && !isNaN(prevCompareValue!) && 
                       prevValue >= prevCompareValue! && currentValue < compareValue;
            break;
        }
      } else {
        switch (condition) {
          case 'Less Than': triggered = currentValue < targetValue; break;
          case 'Greater Than': triggered = currentValue > targetValue; break;
          case 'Crossing Up': triggered = !isNaN(prevValue) && prevValue <= targetValue && currentValue > targetValue; break;
          case 'Crossing Down': triggered = !isNaN(prevValue) && prevValue >= targetValue && currentValue < targetValue; break;
        }
      }
      
      proofs.push({
        indicator: indicatorName,
        value: Math.round(currentValue * 100) / 100,
        condition: condition || '',
        target: Math.round(displayTarget * 100) / 100,
        triggered,
        timeframe,
      });
      
      if (!triggered) return { passed: false, proofs };
    }
    
    return { passed: true, proofs };
  }

  // Main backtest function
  async runBacktest(dto: RunBacktestDto): Promise<{
    status: string;
    message: string;
    metrics?: BacktestMetrics;
    trades?: Array<Omit<TradeEvent, 'timestamp'> & { timestamp: string }>;
    chartData?: { timestamps: string[]; balance: number[]; drawdown: number[] };
  }> {
    this.logger.log(`Running backtest: ${dto.strategy_name}`);
    
    const pairs = dto.pairs || ['BTC/USDT'];
    const initialBalance = dto.initial_balance || 5000;
    const maxActiveDeals = dto.max_active_deals || 5;
    const baseOrderSize = dto.base_order_size || 1000;
    const startDate = new Date(dto.start_date || Date.now() - 365 * 24 * 60 * 60 * 1000);
    const endDate = new Date(dto.end_date || Date.now());
    
    const entryConditions = dto.entry_conditions || dto.bullish_entry_conditions || [];
    const exitConditions = dto.exit_conditions || dto.bullish_exit_conditions || [];
    
    if (entryConditions.length === 0) {
      return { status: 'error', message: 'No entry conditions specified' };
    }
    
    // Use the timeframe from conditions
    const timeframe = entryConditions[0]?.subfields?.Timeframe || '1h';
    
    const trades: TradeEvent[] = [];
    let balance = initialBalance;
    let maxBalance = initialBalance;
    let maxDrawdown = 0;
    let wins = 0, losses = 0;
    let grossProfit = 0, grossLoss = 0;
    const balanceHistory: { timestamp: string; balance: number }[] = [];
    const openPositions: Map<string, Position> = new Map();
    let tradeId = 0;
    let exposureBars = 0, totalBars = 0;
    
    for (const symbol of pairs) {
      try {
        // Fetch data on demand
        const data = await this.fetchHistoricalData(symbol, timeframe, startDate, endDate);
        
        if (data.length < 100) {
          this.logger.warn(`Not enough data for ${symbol}: ${data.length} candles`);
          continue;
        }
        
        const closes = data.map(d => d.close);
        totalBars += data.length;
        
        // Skip first 50 bars for indicator warmup
        for (let i = 50; i < data.length; i++) {
          const candle = data[i];
          const price = candle.close;
          
          const position = openPositions.get(symbol);
          
          if (position) {
            exposureBars++;
            const profitPercent = ((price - position.entryPrice) / position.entryPrice) * 100;
            
            const takeProfitHit = dto.take_profit && profitPercent >= dto.take_profit;
            const stopLossHit = dto.stop_loss && profitPercent <= -dto.stop_loss;
            const exitCheck = this.checkCondition(closes, i, exitConditions);
            
            if (takeProfitHit || stopLossHit || exitCheck.passed) {
              const quantity = position.quantity;
              const profitLoss = (price - position.entryPrice) * quantity;
              
              let exitReason = 'Exit Signal';
              if (takeProfitHit) exitReason = `Take Profit (${dto.take_profit}%)`;
              else if (stopLossHit) exitReason = `Stop Loss (${dto.stop_loss}%)`;
              
              balance += profitLoss;
              if (profitLoss > 0) { wins++; grossProfit += profitLoss; }
              else { losses++; grossLoss += Math.abs(profitLoss); }
              
              if (balance > maxBalance) maxBalance = balance;
              const currentDrawdown = ((maxBalance - balance) / maxBalance) * 100;
              if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
              
              trades.push({
                timestamp: candle.timestamp,
                date: candle.timestamp.toISOString().split('T')[0],
                time: candle.timestamp.toISOString().split('T')[1].split('.')[0],
                symbol,
                action: 'SELL',
                price,
                quantity,
                amount: price * quantity,
                total_amount: baseOrderSize,
                profit_percent: Math.round(profitPercent * 100) / 100,
                profit_usd: Math.round(profitLoss * 100) / 100,
                move_from_entry: (price - position.entryPrice) / position.entryPrice,
                trade_id: `trade-${position.tradeId}`,
                reason: exitReason,
                indicatorProof: exitCheck.proofs,
                equity: Math.round(balance * 100) / 100,
                drawdown: Math.round(currentDrawdown * 100) / 100,
                comment: `${exitReason}: P/L ${profitPercent.toFixed(2)}%`,
                market_state: 'neutral'
              });
              
              openPositions.delete(symbol);
              balanceHistory.push({ timestamp: candle.timestamp.toISOString(), balance: Math.round(balance * 100) / 100 });
            }
          } else if (openPositions.size < maxActiveDeals && balance >= baseOrderSize) {
            const entryCheck = this.checkCondition(closes, i, entryConditions);
            
            if (entryCheck.passed) {
              tradeId++;
              const quantity = baseOrderSize / price;
              
              openPositions.set(symbol, {
                symbol,
                entryPrice: price,
                entryTime: candle.timestamp,
                quantity,
                tradeId,
                entryIndicators: entryCheck.proofs,
              });
              
              const currentDrawdown = maxBalance > 0 ? ((maxBalance - balance) / maxBalance) * 100 : 0;
              
              trades.push({
                timestamp: candle.timestamp,
                date: candle.timestamp.toISOString().split('T')[0],
                time: candle.timestamp.toISOString().split('T')[1].split('.')[0],
                symbol,
                action: 'BUY',
                price,
                quantity,
                amount: baseOrderSize,
                total_amount: baseOrderSize,
                profit_percent: 0,
                profit_usd: 0,
                move_from_entry: 0,
                trade_id: `trade-${tradeId}`,
                reason: 'Entry Signal',
                indicatorProof: entryCheck.proofs,
                equity: Math.round(balance * 100) / 100,
                drawdown: Math.round(currentDrawdown * 100) / 100,
                comment: 'Entry signal triggered',
                market_state: 'neutral'
              });
            }
          }
        }
        
        // Close remaining positions
        for (const [sym, pos] of openPositions) {
          if (sym === symbol) {
            const lastPrice = data[data.length - 1].close;
            const profitLoss = (lastPrice - pos.entryPrice) * pos.quantity;
            const profitPercent = ((lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
            
            balance += profitLoss;
            if (profitLoss > 0) { wins++; grossProfit += profitLoss; }
            else { losses++; grossLoss += Math.abs(profitLoss); }
            
            const exitDate = data[data.length - 1].timestamp;
            const currentDrawdown = maxBalance > 0 ? ((maxBalance - balance) / maxBalance) * 100 : 0;
            
            trades.push({
              timestamp: exitDate,
              date: exitDate.toISOString().split('T')[0],
              time: exitDate.toISOString().split('T')[1].split('.')[0],
              symbol,
              action: 'SELL',
              price: lastPrice,
              quantity: pos.quantity,
              amount: lastPrice * pos.quantity,
              total_amount: baseOrderSize,
              profit_percent: Math.round(profitPercent * 100) / 100,
              profit_usd: Math.round(profitLoss * 100) / 100,
              move_from_entry: (lastPrice - pos.entryPrice) / pos.entryPrice,
              trade_id: `trade-${pos.tradeId}`,
              reason: 'Backtest End',
              indicatorProof: [],
              equity: Math.round(balance * 100) / 100,
              drawdown: Math.round(currentDrawdown * 100) / 100,
              comment: 'Position closed at backtest end',
              market_state: 'neutral'
            });
            
            openPositions.delete(sym);
          }
        }
      } catch (error) {
        this.logger.error(`Failed to backtest ${symbol}: ${error.message}`);
      }
    }
    
    const totalTrades = wins + losses;
    
    if (totalTrades === 0) {
      return {
        status: 'success',
        message: 'No trades triggered with these conditions',
        metrics: {
          net_profit: 0, net_profit_usd: '$0.00', total_profit: 0, total_profit_usd: '$0.00',
          max_drawdown: 0, max_realized_drawdown: 0, sharpe_ratio: 0, sortino_ratio: 0,
          win_rate: 0, total_trades: 0, profit_factor: 0, avg_profit_per_trade: 0,
          yearly_return: 0, exposure_time_frac: 0,
        },
        trades: [],
        chartData: { timestamps: [startDate.toISOString()], balance: [initialBalance], drawdown: [0] }
      };
    }
    
    const netProfit = (balance - initialBalance) / initialBalance * 100;
    const totalDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    const annualizedReturn = totalDays > 0 ? Math.pow(1 + netProfit / 100, 365 / totalDays) - 1 : 0;
    
    const dailyReturns = balanceHistory.length > 1 
      ? balanceHistory.map((b, i) => i === 0 ? 0 : (b.balance - balanceHistory[i-1].balance) / balanceHistory[i-1].balance).slice(1)
      : [0];
    
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
    const stdDev = Math.sqrt(dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (dailyReturns.length || 1));
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
    
    const negativeReturns = dailyReturns.filter(r => r < 0);
    const downsideStd = Math.sqrt(negativeReturns.reduce((sum, r) => sum + r * r, 0) / (negativeReturns.length || 1));
    const sortinoRatio = downsideStd > 0 ? (avgReturn / downsideStd) * Math.sqrt(252) : 0;
    
    return {
      status: 'success',
      message: `Backtest completed: ${totalTrades} trades on ${pairs.length} pairs`,
      metrics: {
        net_profit: Math.round(netProfit * 100) / 100,
        net_profit_usd: `$${Math.round((balance - initialBalance) * 100) / 100}`,
        total_profit: Math.round(netProfit * 100) / 100,
        total_profit_usd: `$${Math.round((balance - initialBalance) * 100) / 100}`,
        max_drawdown: Math.round(maxDrawdown * 100) / 100,
        max_realized_drawdown: Math.round(maxDrawdown * 100) / 100,
        sharpe_ratio: Math.round(sharpeRatio * 100) / 100,
        sortino_ratio: Math.round(sortinoRatio * 100) / 100,
        win_rate: Math.round((wins / totalTrades) * 10000) / 100,
        total_trades: totalTrades,
        profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : 'Infinity',
        avg_profit_per_trade: Math.round(((balance - initialBalance) / totalTrades) * 100) / 100,
        yearly_return: Math.round(annualizedReturn * 10000) / 100,
        exposure_time_frac: totalBars > 0 ? Math.round((exposureBars / totalBars) * 10000) / 100 : 0
      },
      trades: trades.map(t => ({
        ...t,
        timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : t.timestamp,
        price: Math.round(t.price * 100) / 100,
      })),
      chartData: {
        timestamps: balanceHistory.map(b => b.timestamp),
        balance: balanceHistory.map(b => b.balance),
        drawdown: balanceHistory.map((b, i) => {
          const maxSoFar = Math.max(initialBalance, ...balanceHistory.slice(0, i + 1).map(x => x.balance));
          return Math.round(((maxSoFar - b.balance) / maxSoFar) * 10000) / 100;
        })
      }
    };
  }

  // Save/Get methods remain the same
  async saveBacktestResult(userId: number, dto: RunBacktestDto, result: any) {
    return this.prisma.backtestResult.create({
      data: {
        userId,
        name: dto.strategy_name,
        config: JSON.stringify({ entry_conditions: dto.entry_conditions, exit_conditions: dto.exit_conditions }),
        pairs: JSON.stringify(dto.pairs || []),
        startDate: new Date(dto.start_date || Date.now() - 90 * 24 * 60 * 60 * 1000),
        endDate: new Date(dto.end_date || Date.now()),
        initialBalance: dto.initial_balance || 5000,
        netProfit: result.metrics?.net_profit || 0,
        netProfitUsd: parseFloat(result.metrics?.net_profit_usd?.replace('$', '') || '0'),
        maxDrawdown: result.metrics?.max_drawdown || 0,
        sharpeRatio: result.metrics?.sharpe_ratio || 0,
        sortinoRatio: result.metrics?.sortino_ratio || 0,
        winRate: result.metrics?.win_rate || 0,
        totalTrades: result.metrics?.total_trades || 0,
        profitFactor: typeof result.metrics?.profit_factor === 'number' ? result.metrics.profit_factor : 0,
        yearlyReturn: result.metrics?.yearly_return || 0,
        chartData: JSON.stringify(result.chartData || {}),
        trades: JSON.stringify(result.trades || []),
      }
    });
  }

  async getBacktestResults(userId?: number) {
    const results = await this.prisma.backtestResult.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return results.map(r => ({
      id: r.id,
      strategy_name: r.name,
      timestamp_run: r.createdAt.toISOString(),
      net_profit: r.netProfit,
      max_drawdown: r.maxDrawdown,
      sharpe_ratio: r.sharpeRatio,
      total_trades: r.totalTrades,
      win_rate: r.winRate,
      yearly_return: r.yearlyReturn,
    }));
  }

  async getBacktestResult(id: number, userId?: number) {
    const result = await this.prisma.backtestResult.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
    });
    if (!result) return null;
    return {
      ...result,
      config: JSON.parse(result.config),
      pairs: JSON.parse(result.pairs),
      chartData: result.chartData ? JSON.parse(result.chartData) : null,
      trades: result.trades ? JSON.parse(result.trades) : [],
    };
  }

  async saveAsStrategy(userId: number, backtestId: number, name: string, description?: string) {
    const backtest = await this.prisma.backtestResult.findFirst({ where: { id: backtestId, userId } });
    if (!backtest) throw new Error('Backtest result not found');
    
    return this.prisma.strategy.create({
      data: {
        userId, name, description, category: 'Custom',
        config: backtest.config, pairs: backtest.pairs,
        maxDeals: 5, orderSize: 1000,
        lastBacktestProfit: backtest.netProfit,
        lastBacktestDrawdown: backtest.maxDrawdown,
        lastBacktestSharpe: backtest.sharpeRatio,
        lastBacktestWinRate: backtest.winRate,
      }
    });
  }

  async deleteBacktestResult(id: number, userId: number) {
    await this.prisma.backtestResult.deleteMany({ where: { id, userId } });
    return { success: true };
  }
}
