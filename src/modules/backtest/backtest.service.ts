// src/modules/backtest/backtest.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RunBacktestDto, StrategyCondition } from './dto/backtest.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { DataFetcherService, CandleWithIndicators } from './data-fetcher.service';

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

  // Predefined strategy templates with real conditions - THE RSI_MA_BB strategy from the CSV
  private readonly strategyTemplates: Record<string, {
    name: string;
    description: string;
    category: string;
    pairs: string[];
    entry_conditions: StrategyCondition[];
    exit_conditions: StrategyCondition[];
    take_profit?: number;
    stop_loss?: number;
    safety_order_toggle?: boolean;
    max_safety_orders?: number;
    safety_order_size?: number;
    price_deviation?: number;
    safety_order_volume_scale?: number;
    safety_order_step_scale?: number;
  }> = {
    'rsi-ma-bb-golden': {
      name: 'RSI+MA+BB Golden Strategy',
      description: 'The proven strategy with 148% yearly return. Uses RSI > 70 on 15m with SMA 50/200 confirmation on 1h, exits when BB%B < 0.1 on 4h.',
      category: 'Multi-Indicator / Trend & Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'NEAR/USDT', 'LTC/USDT', 'HBAR/USDT', 'SUI/USDT', 'TRX/USDT', 'BCH/USDT', 'RENDER/USDT', 'ATOM/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 28, Timeframe: '15m', Condition: 'Greater Than', 'Signal Value': 70 } },
        { indicator: 'MA', subfields: { 'MA Type': 'SMA', 'Fast MA': 50, 'Slow MA': 200, Condition: 'Greater Than', Timeframe: '1h' } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 1, Condition: 'Less Than', Timeframe: '4h', 'Signal Value': 0.1 } }
      ]
    },
    'rsi-oversold-scalper': {
      name: 'RSI Oversold Scalper',
      description: 'Quick scalping strategy that buys when RSI < 25 and sells when RSI > 65. Works on multiple pairs.',
      category: 'Scalping / Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '15m', Condition: 'Less Than', 'Signal Value': 25 } }
      ],
      exit_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '15m', Condition: 'Greater Than', 'Signal Value': 65 } }
      ],
      take_profit: 3,
      stop_loss: 2
    },
    'macd-trend-follower': {
      name: 'MACD Trend Follower',
      description: 'Trend following strategy using MACD crossovers on daily timeframe. Catches major market moves.',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT'],
      entry_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '1d', 'MACD Trigger': 'Crossing Up', 'Line Trigger': 'Greater Than 0' } }
      ],
      exit_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '1d', 'MACD Trigger': 'Crossing Down' } }
      ]
    },
    'bb-squeeze-breakout': {
      name: 'Bollinger Squeeze Breakout',
      description: 'Enters when price breaks above upper Bollinger Band after a squeeze. Uses tight stop loss.',
      category: 'Volatility Breakout',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'AVAX/USDT'],
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
      description: 'Classic moving average crossover strategy. Enters on golden cross (EMA 20 > EMA 50), exits on death cross.',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'],
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataFetcher: DataFetcherService,
  ) {}

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

  // Calculate real metrics for a preset strategy (including yearly breakdown)
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
      this.logger.log(`Calculating real metrics for preset strategy: ${strategyId}`);
      
      // Run backtest from 2020 to now
      const startDate = new Date('2020-01-01');
      const endDate = new Date();
      
      const result = await this.runBacktest({
        strategy_name: template.name,
        pairs: template.pairs,
        initial_balance: 5000,
        base_order_size: 1000,
        max_active_deals: 5,
        entry_conditions: template.entry_conditions,
        exit_conditions: template.exit_conditions,
        take_profit: template.take_profit,
        stop_loss: template.stop_loss,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
      });
      
      // Calculate yearly performance breakdown
      const yearlyPerformance = await this.calculateYearlyPerformance(
        template, startDate, endDate
      );
      
      if (result.status === 'success' && result.metrics) {
        // Cache the results
        this.presetMetricsCache.set(strategyId, {
          metrics: result.metrics,
          yearlyPerformance,
          calculatedAt: new Date(),
        });
        
        return {
          id: strategyId,
          name: template.name,
          metrics: result.metrics,
          yearlyPerformance,
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

  // Calculate yearly performance for each year from 2020-2025
  private async calculateYearlyPerformance(
    template: typeof this.strategyTemplates[string],
    startDate: Date,
    endDate: Date
  ): Promise<YearlyPerformance[]> {
    const yearlyPerformance: YearlyPerformance[] = [];
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    
    for (let year = startYear; year <= endYear; year++) {
      const yearStart = new Date(`${year}-01-01`);
      const yearEnd = new Date(`${year}-12-31`);
      
      if (yearStart > endDate) break;
      
      try {
        const result = await this.runBacktest({
          strategy_name: `${template.name} (${year})`,
          pairs: template.pairs,
          initial_balance: 5000,
          base_order_size: 1000,
          max_active_deals: 5,
          entry_conditions: template.entry_conditions,
          exit_conditions: template.exit_conditions,
          take_profit: template.take_profit,
          stop_loss: template.stop_loss,
          start_date: yearStart.toISOString(),
          end_date: yearEnd < endDate ? yearEnd.toISOString() : endDate.toISOString(),
        });
        
        if (result.metrics) {
          yearlyPerformance.push({
            year,
            net_profit: result.metrics.net_profit,
            net_profit_usd: result.metrics.net_profit_usd,
            total_trades: result.metrics.total_trades,
            win_rate: result.metrics.win_rate,
            max_drawdown: result.metrics.max_drawdown,
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to calculate ${year} performance: ${error.message}`);
      }
    }
    
    return yearlyPerformance;
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
          { key: 'MA Type', type: 'select', options: ['SMA', 'EMA', 'WMA'], default: 'SMA' },
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
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1d' },
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

  // Get indicator value from cached data
  private getIndicatorValueFromData(
    data: CandleWithIndicators[],
    index: number,
    indicator: string,
    subfields: Record<string, any>
  ): { value: number; compareValue?: number } | null {
    if (index < 0 || index >= data.length) return null;
    
    const candle = data[index];
    
    switch (indicator) {
      case 'RSI': {
        const period = parseInt(String(subfields['RSI Length'] || 14));
        const key = `RSI_${period}` as keyof typeof candle;
        const value = candle[key] as number | undefined;
        return value !== undefined && !isNaN(value) ? { value } : null;
      }
      case 'MA': {
        const maType = subfields['MA Type'] || 'SMA';
        const fastPeriod = parseInt(String(subfields['Fast MA'] || 20));
        const slowPeriod = parseInt(String(subfields['Slow MA'] || 50));
        
        const fastKey = `${maType}_${fastPeriod}` as keyof typeof candle;
        const slowKey = `${maType}_${slowPeriod}` as keyof typeof candle;
        
        const fastValue = candle[fastKey] as number | undefined;
        const slowValue = candle[slowKey] as number | undefined;
        
        if (fastValue !== undefined && slowValue !== undefined && !isNaN(fastValue) && !isNaN(slowValue)) {
          return { value: fastValue, compareValue: slowValue };
        }
        return null;
      }
      case 'MACD': {
        const preset = String(subfields['MACD Preset'] || '12,26,9');
        const [fast, slow, signal] = preset.split(',').map(Number);
        
        const lineKey = `MACD_${fast}_${slow}_${signal}` as keyof typeof candle;
        const signalKey = `MACD_${fast}_${slow}_${signal}_signal` as keyof typeof candle;
        
        const lineValue = candle[lineKey] as number | undefined;
        const signalValue = candle[signalKey] as number | undefined;
        
        if (lineValue !== undefined && signalValue !== undefined && !isNaN(lineValue) && !isNaN(signalValue)) {
          return { value: lineValue, compareValue: signalValue };
        }
        return null;
      }
      case 'BollingerBands': {
        const period = parseInt(String(subfields['BB% Period'] || 20));
        const deviation = parseFloat(String(subfields['Deviation'] || 2));
        
        const key = `BB_pctB_${period}_${deviation}` as keyof typeof candle;
        const value = candle[key] as number | undefined;
        
        return value !== undefined && !isNaN(value) ? { value } : null;
      }
    }
    
    return null;
  }

  // Check condition at a specific index using cached data
  private checkConditionAtIndex(
    data: CandleWithIndicators[],
    index: number,
    conditions: StrategyCondition[]
  ): { passed: boolean; proofs: IndicatorProof[] } {
    if (!conditions || conditions.length === 0) {
      return { passed: false, proofs: [] };
    }
    
    const proofs: IndicatorProof[] = [];
    
    for (const cond of conditions) {
      const subfields = cond.subfields || {};
      const condition = subfields.Condition || subfields['MACD Trigger'];
      const targetValue = parseFloat(String(subfields['Signal Value'] ?? 0));
      const timeframe = subfields.Timeframe || '1h';
      
      const values = this.getIndicatorValueFromData(data, index, cond.indicator, subfields);
      const prevValues = index > 0 ? this.getIndicatorValueFromData(data, index - 1, cond.indicator, subfields) : null;
      
      if (!values) {
        return { passed: false, proofs };
      }
      
      let triggered = false;
      let indicatorName = cond.indicator;
      let displayTarget = targetValue;
      
      // For MA and MACD, compare fast to slow/signal
      if (cond.indicator === 'MA' || cond.indicator === 'MACD') {
        if (values.compareValue === undefined) {
          return { passed: false, proofs };
        }
        
        displayTarget = values.compareValue;
        
        switch (condition) {
          case 'Less Than':
            triggered = values.value < values.compareValue;
            break;
          case 'Greater Than':
            triggered = values.value > values.compareValue;
            break;
          case 'Crossing Up':
            if (!prevValues || prevValues.compareValue === undefined) {
              return { passed: false, proofs };
            }
            triggered = prevValues.value <= prevValues.compareValue && values.value > values.compareValue;
            break;
          case 'Crossing Down':
            if (!prevValues || prevValues.compareValue === undefined) {
              return { passed: false, proofs };
            }
            triggered = prevValues.value >= prevValues.compareValue && values.value < values.compareValue;
            break;
        }
        
        // Check line trigger for MACD
        if (cond.indicator === 'MACD') {
          const lineTrigger = subfields['Line Trigger'];
          if (lineTrigger === 'Greater Than 0' && values.value <= 0) triggered = false;
          if (lineTrigger === 'Less Than 0' && values.value >= 0) triggered = false;
          
          indicatorName = `MACD(${subfields['MACD Preset']})`;
        } else {
          indicatorName = `${subfields['MA Type']}(${subfields['Fast MA']}/${subfields['Slow MA']})`;
        }
      } else {
        // For RSI and BB, compare to target value
        switch (condition) {
          case 'Less Than':
            triggered = values.value < targetValue;
            break;
          case 'Greater Than':
            triggered = values.value > targetValue;
            break;
          case 'Crossing Up':
            if (!prevValues) {
              return { passed: false, proofs };
            }
            triggered = prevValues.value <= targetValue && values.value > targetValue;
            break;
          case 'Crossing Down':
            if (!prevValues) {
              return { passed: false, proofs };
            }
            triggered = prevValues.value >= targetValue && values.value < targetValue;
            break;
        }
        
        if (cond.indicator === 'RSI') {
          indicatorName = `RSI(${subfields['RSI Length']})`;
        } else if (cond.indicator === 'BollingerBands') {
          indicatorName = `BB%B(${subfields['BB% Period']},${subfields['Deviation']})`;
        }
      }
      
      proofs.push({
        indicator: indicatorName,
        value: Math.round(values.value * 100) / 100,
        condition: condition || '',
        target: Math.round(displayTarget * 100) / 100,
        triggered,
        timeframe,
      });
      
      if (!triggered) {
        return { passed: false, proofs };
      }
    }
    
    return { passed: true, proofs };
  }

  // Main backtest function with REAL data
  async runBacktest(dto: RunBacktestDto): Promise<{
    status: string;
    message: string;
    metrics?: BacktestMetrics;
    trades?: Array<Omit<TradeEvent, 'timestamp'> & { timestamp: string }>;
    chartData?: {
      timestamps: string[];
      balance: number[];
      drawdown: number[];
    };
  }> {
    this.logger.log(`Running REAL backtest: ${dto.strategy_name}`);
    
    const pairs = dto.pairs || ['BTC/USDT'];
    const initialBalance = dto.initial_balance || 5000;
    const maxActiveDeals = dto.max_active_deals || 5;
    const baseOrderSize = dto.base_order_size || 1000;
    const startDate = new Date(dto.start_date || Date.now() - 365 * 24 * 60 * 60 * 1000); // Default 1 year
    const endDate = new Date(dto.end_date || Date.now());
    
    const entryConditions = dto.entry_conditions || dto.bullish_entry_conditions || [];
    const exitConditions = dto.exit_conditions || dto.bullish_exit_conditions || [];
    
    if (entryConditions.length === 0) {
      return {
        status: 'error',
        message: 'No entry conditions specified'
      };
    }
    
    // Determine the timeframe from conditions
    const timeframe = entryConditions[0]?.subfields?.Timeframe || '1h';
    
    const trades: TradeEvent[] = [];
    let balance = initialBalance;
    let maxBalance = initialBalance;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const balanceHistory: { timestamp: string; balance: number }[] = [];
    const openPositions: Map<string, Position> = new Map();
    let tradeId = 0;
    let exposureBars = 0;
    let totalBars = 0;
    
    for (const symbol of pairs) {
      try {
        // Get data from cache
        let data = this.dataFetcher.getDataInRange(symbol, timeframe, startDate, endDate);
        
        // If no cached data, fetch it
        if (data.length < 50) {
          this.logger.log(`No cached data for ${symbol} ${timeframe}, fetching...`);
          const rawData = await this.dataFetcher.fetchHistoricalData(symbol, timeframe, startDate, endDate);
          if (rawData.length < 50) {
            this.logger.warn(`Not enough data for ${symbol}: ${rawData.length} candles`);
            continue;
          }
          data = rawData;
        }
        
        totalBars += data.length;
        
        // Iterate through each candle
        for (let i = 50; i < data.length; i++) {
          const candle = data[i];
          const price = candle.close;
          
          const position = openPositions.get(symbol);
          
          if (position) {
            exposureBars++;
            
            const profitPercent = ((price - position.entryPrice) / position.entryPrice) * 100;
            
            // Check Take Profit
            const takeProfitHit = dto.take_profit && profitPercent >= dto.take_profit;
            
            // Check Stop Loss
            const stopLossHit = dto.stop_loss && profitPercent <= -dto.stop_loss;
            
            // Check exit conditions
            const exitCheck = this.checkConditionAtIndex(data, i, exitConditions);
            
            if (takeProfitHit || stopLossHit || exitCheck.passed) {
              const quantity = position.quantity;
              const profitLoss = (price - position.entryPrice) * quantity;
              
              let exitReason = 'Exit Signal';
              const exitProofs = [...exitCheck.proofs];
              
              if (takeProfitHit) {
                exitReason = `Take Profit (${dto.take_profit}%)`;
                exitProofs.push({
                  indicator: 'Profit %',
                  value: profitPercent,
                  condition: '>=',
                  target: dto.take_profit!,
                  triggered: true,
                  timeframe: '',
                });
              } else if (stopLossHit) {
                exitReason = `Stop Loss (${dto.stop_loss}%)`;
                exitProofs.push({
                  indicator: 'Loss %',
                  value: profitPercent,
                  condition: '<=',
                  target: -dto.stop_loss!,
                  triggered: true,
                  timeframe: '',
                });
              }
              
              balance += profitLoss;
              
              if (profitLoss > 0) {
                wins++;
                grossProfit += profitLoss;
              } else {
                losses++;
                grossLoss += Math.abs(profitLoss);
              }
              
              if (balance > maxBalance) maxBalance = balance;
              const currentDrawdown = ((maxBalance - balance) / maxBalance) * 100;
              if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
              
              const exitDate = candle.timestamp;
              trades.push({
                timestamp: exitDate,
                date: exitDate.toISOString().split('T')[0],
                time: exitDate.toISOString().split('T')[1].split('.')[0],
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
                indicatorProof: exitProofs,
                equity: Math.round(balance * 100) / 100,
                drawdown: Math.round(currentDrawdown * 100) / 100,
                comment: `${exitReason}: P/L ${profitPercent.toFixed(2)}%`,
                market_state: 'neutral'
              });
              
              openPositions.delete(symbol);
              
              balanceHistory.push({
                timestamp: candle.timestamp.toISOString(),
                balance: Math.round(balance * 100) / 100
              });
            }
          } else {
            // Check entry conditions
            if (openPositions.size < maxActiveDeals && balance >= baseOrderSize) {
              const entryCheck = this.checkConditionAtIndex(data, i, entryConditions);
              
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
                
                const entryDate = candle.timestamp;
                trades.push({
                  timestamp: entryDate,
                  date: entryDate.toISOString().split('T')[0],
                  time: entryDate.toISOString().split('T')[1].split('.')[0],
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
                  reason: 'Entry Signal - All conditions triggered',
                  indicatorProof: entryCheck.proofs,
                  equity: Math.round(balance * 100) / 100,
                  drawdown: Math.round(currentDrawdown * 100) / 100,
                  comment: 'Entry signal triggered',
                  market_state: 'neutral'
                });
              }
            }
          }
        }
        
        // Close remaining positions at end
        for (const [sym, pos] of openPositions) {
          if (sym === symbol) {
            const lastPrice = data[data.length - 1].close;
            const profitLoss = (lastPrice - pos.entryPrice) * pos.quantity;
            const profitPercent = ((lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
            
            balance += profitLoss;
            if (profitLoss > 0) {
              wins++;
              grossProfit += profitLoss;
            } else {
              losses++;
              grossLoss += Math.abs(profitLoss);
            }
            
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
              reason: 'Backtest End - Position Auto-Closed',
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
    
    // Calculate final metrics
    const totalTrades = wins + losses;
    
    if (totalTrades === 0) {
      return {
        status: 'success',
        message: 'Backtest completed: No trades triggered with these conditions',
        metrics: {
          net_profit: 0,
          net_profit_usd: '$0.00',
          total_profit: 0,
          total_profit_usd: '$0.00',
          max_drawdown: 0,
          max_realized_drawdown: 0,
          sharpe_ratio: 0,
          sortino_ratio: 0,
          win_rate: 0,
          total_trades: 0,
          profit_factor: 0,
          avg_profit_per_trade: 0,
          yearly_return: 0,
          exposure_time_frac: 0,
        },
        trades: [],
        chartData: {
          timestamps: [startDate.toISOString()],
          balance: [initialBalance],
          drawdown: [0]
        }
      };
    }
    
    const netProfit = (balance - initialBalance) / initialBalance * 100;
    const totalDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    const annualizedReturn = totalDays > 0 ? Math.pow(1 + netProfit / 100, 365 / totalDays) - 1 : 0;
    
    // Calculate Sharpe ratio
    const dailyReturns = balanceHistory.length > 1 
      ? balanceHistory.map((b, i) => 
          i === 0 ? 0 : (b.balance - balanceHistory[i-1].balance) / balanceHistory[i-1].balance
        ).slice(1)
      : [0];
    
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
    const stdDev = Math.sqrt(
      dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (dailyReturns.length || 1)
    );
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
    
    // Calculate Sortino ratio
    const negativeReturns = dailyReturns.filter(r => r < 0);
    const downsideStd = Math.sqrt(
      negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / (negativeReturns.length || 1)
    );
    const sortinoRatio = downsideStd > 0 ? (avgReturn / downsideStd) * Math.sqrt(252) : 0;
    
    const metrics: BacktestMetrics = {
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
    };
    
    const chartData = {
      timestamps: balanceHistory.map(b => b.timestamp),
      balance: balanceHistory.map(b => b.balance),
      drawdown: balanceHistory.map((b, i) => {
        const maxSoFar = Math.max(initialBalance, ...balanceHistory.slice(0, i + 1).map(x => x.balance));
        return Math.round(((maxSoFar - b.balance) / maxSoFar) * 10000) / 100;
      })
    };
    
    return {
      status: 'success',
      message: `Backtest completed with REAL data: ${totalTrades} trades on ${pairs.length} pairs`,
      metrics,
      trades: trades.map(t => ({
        ...t,
        timestamp: t.timestamp instanceof Date ? t.timestamp.toISOString() : t.timestamp,
        price: Math.round(t.price * 100) / 100,
        amount: Math.round(t.amount * 100) / 100,
      })),
      chartData
    };
  }

  // Save backtest result to database
  async saveBacktestResult(userId: number, dto: RunBacktestDto, result: any) {
    const backtestResult = await this.prisma.backtestResult.create({
      data: {
        userId,
        name: dto.strategy_name,
        config: JSON.stringify({
          entry_conditions: dto.entry_conditions,
          exit_conditions: dto.exit_conditions,
          bullish_entry_conditions: dto.bullish_entry_conditions,
          bearish_entry_conditions: dto.bearish_entry_conditions,
          bullish_exit_conditions: dto.bullish_exit_conditions,
          bearish_exit_conditions: dto.bearish_exit_conditions,
        }),
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

    return backtestResult;
  }

  // Get saved backtest results for user
  async getBacktestResults(userId?: number): Promise<any[]> {
    const results = await this.prisma.backtestResult.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        strategy: {
          select: { id: true, name: true }
        }
      }
    });

    return results.map(r => ({
      id: r.id,
      strategy_name: r.name,
      timestamp_run: r.createdAt.toISOString(),
      net_profit: r.netProfit,
      max_drawdown: r.maxDrawdown,
      sharpe_ratio: r.sharpeRatio,
      sortino_ratio: r.sortinoRatio,
      total_trades: r.totalTrades,
      win_rate: r.winRate,
      profit_factor: r.profitFactor,
      yearly_return: r.yearlyReturn,
      linked_strategy: r.strategy,
    }));
  }

  // Get single backtest result with full details
  async getBacktestResult(id: number, userId?: number) {
    const result = await this.prisma.backtestResult.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
      include: { strategy: true }
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

  // Save backtest as a reusable strategy
  async saveAsStrategy(userId: number, backtestId: number, name: string, description?: string) {
    const backtest = await this.prisma.backtestResult.findFirst({
      where: { id: backtestId, userId }
    });

    if (!backtest) {
      throw new Error('Backtest result not found');
    }

    const strategy = await this.prisma.strategy.create({
      data: {
        userId,
        name,
        description,
        category: 'Custom',
        config: backtest.config,
        pairs: backtest.pairs,
        maxDeals: 5,
        orderSize: 1000,
        lastBacktestProfit: backtest.netProfit,
        lastBacktestDrawdown: backtest.maxDrawdown,
        lastBacktestSharpe: backtest.sharpeRatio,
        lastBacktestWinRate: backtest.winRate,
      }
    });

    // Link backtest to strategy
    await this.prisma.backtestResult.update({
      where: { id: backtestId },
      data: { strategyId: strategy.id }
    });

    return strategy;
  }

  // Delete backtest result
  async deleteBacktestResult(id: number, userId: number) {
    await this.prisma.backtestResult.deleteMany({
      where: { id, userId }
    });
    return { success: true };
  }
}
