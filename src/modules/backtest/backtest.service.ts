import { Injectable, Logger } from '@nestjs/common';
import { RunBacktestDto, StrategyCondition } from './dto/backtest.dto';
import { PrismaService } from '../../prisma/prisma.service';
import * as ccxt from 'ccxt';

export interface TradeEvent {
  timestamp: Date;
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  amount: number;
  total_amount: number;
  profit_percent: number;
  move_from_entry: number;
  trade_id: string;
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

export interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface IndicatorData {
  rsi: number[];
  smaFast: number[];
  smaSlow: number[];
  emaFast: number[];
  emaSlow: number[];
  macdLine: number[];
  macdSignal: number[];
  bbPercent: number[];
}

interface Position {
  symbol: string;
  entryPrice: number;
  entryTime: Date;
  quantity: number;
  entryIndex: number;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private exchange: ccxt.Exchange;

  constructor(private readonly prisma: PrismaService) {
    // Initialize Binance exchange (public API - no auth needed for OHLCV)
    this.exchange = new ccxt.binance({
      enableRateLimit: true,
    });
  }

  // Predefined strategy templates
  private readonly strategyTemplates = {
    'rsi-oversold': {
      name: 'RSI Oversold Bounce',
      description: 'Buy when RSI < 30, Sell when RSI > 70',
      entry_conditions: [
        { indicator: 'RSI', subfields: { Timeframe: '1h', Condition: 'Less Than', 'Signal Value': 30, 'RSI Length': 14 } }
      ],
      exit_conditions: [
        { indicator: 'RSI', subfields: { Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 70, 'RSI Length': 14 } }
      ]
    },
    'ma-crossover': {
      name: 'Moving Average Crossover',
      description: 'Buy when Fast MA crosses above Slow MA',
      entry_conditions: [
        { indicator: 'MA', subfields: { Timeframe: '4h', Condition: 'Crossing Up', 'MA Type': 'SMA', 'Fast MA': 20, 'Slow MA': 50 } }
      ],
      exit_conditions: [
        { indicator: 'MA', subfields: { Timeframe: '4h', Condition: 'Crossing Down', 'MA Type': 'SMA', 'Fast MA': 20, 'Slow MA': 50 } }
      ]
    },
    'macd-momentum': {
      name: 'MACD Momentum',
      description: 'Trade MACD crossovers with trend filter',
      bullish_entry_conditions: [
        { indicator: 'MACD', subfields: { Timeframe: '1d', 'MACD Preset': '12,26,9', 'MACD Trigger': 'Crossing Up', 'Line Trigger': 'Greater Than 0' } }
      ],
      bullish_exit_conditions: [
        { indicator: 'MACD', subfields: { Timeframe: '1d', 'MACD Preset': '12,26,9', 'MACD Trigger': 'Crossing Down' } }
      ],
      bearish_entry_conditions: [
        { indicator: 'MACD', subfields: { Timeframe: '1d', 'MACD Preset': '12,26,9', 'MACD Trigger': 'Crossing Down', 'Line Trigger': 'Less Than 0' } }
      ],
      bearish_exit_conditions: [
        { indicator: 'MACD', subfields: { Timeframe: '1d', 'MACD Preset': '12,26,9', 'MACD Trigger': 'Crossing Up' } }
      ]
    },
    'bb-mean-reversion': {
      name: 'Bollinger Bands Mean Reversion',
      description: 'Buy at lower band, Sell at upper band',
      entry_conditions: [
        { indicator: 'BollingerBands', subfields: { Timeframe: '1h', Condition: 'Less Than', 'Signal Value': 0, 'BB% Period': 20, Deviation: 2 } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 1, 'BB% Period': 20, Deviation: 2 } }
      ]
    }
  };

  getStrategyTemplates() {
    return Object.entries(this.strategyTemplates).map(([id, template]) => ({
      id,
      ...template
    }));
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

  // Fetch REAL historical data from Binance
  private async fetchHistoricalData(
    symbol: string, 
    timeframe: string, 
    startDate: Date, 
    endDate: Date
  ): Promise<OHLCV[]> {
    try {
      const since = startDate.getTime();
      const allData: OHLCV[] = [];
      let currentSince = since;
      const limit = 1000; // Binance max limit per request
      
      // Fetch data in chunks
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
        
        // Move to next batch
        const lastTimestamp = ohlcv[ohlcv.length - 1][0] as number;
        if (lastTimestamp <= currentSince) break;
        currentSince = lastTimestamp + 1;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      this.logger.log(`Fetched ${allData.length} candles for ${symbol} ${timeframe}`);
      return allData;
    } catch (error) {
      this.logger.error(`Failed to fetch historical data for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  // Calculate RSI
  private calculateRSI(closes: number[], period: number = 14): number[] {
    if (closes.length < period + 1) return [];
    
    const rsi: number[] = new Array(period).fill(NaN);
    let gains = 0;
    let losses = 0;
    
    // Initial averages
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgGain / (avgLoss || 1e-9);
    rsi.push(100 - 100 / (1 + rs));
    
    // Calculate RSI for remaining periods
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = Math.max(diff, 0);
      const loss = Math.max(-diff, 0);
      
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rs = avgGain / (avgLoss || 1e-9);
      rsi.push(100 - 100 / (1 + rs));
    }
    
    return rsi;
  }

  // Calculate SMA
  private calculateSMA(values: number[], period: number): number[] {
    const sma: number[] = new Array(period - 1).fill(NaN);
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    return sma;
  }

  // Calculate EMA
  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) return new Array(values.length).fill(NaN);
    
    const ema: number[] = new Array(period - 1).fill(NaN);
    const multiplier = 2 / (period + 1);
    
    // Start with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    ema.push(sum / period);
    
    // Calculate EMA
    for (let i = period; i < values.length; i++) {
      ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    
    return ema;
  }

  // Calculate MACD
  private calculateMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
    const emaFast = this.calculateEMA(closes, fast);
    const emaSlow = this.calculateEMA(closes, slow);
    
    const macdLine: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) {
        macdLine.push(NaN);
      } else {
        macdLine.push(emaFast[i] - emaSlow[i]);
      }
    }
    
    // Calculate signal line from valid MACD values
    const validMacd = macdLine.filter(v => !isNaN(v));
    const signalLineValues = this.calculateEMA(validMacd, signal);
    
    // Align signal line with MACD
    const signalLine: number[] = new Array(macdLine.length - validMacd.length).fill(NaN);
    signalLine.push(...signalLineValues);
    
    return { macdLine, signalLine };
  }

  // Calculate Bollinger Bands %B
  private calculateBBPercent(closes: number[], period = 20, deviation = 2): number[] {
    const sma = this.calculateSMA(closes, period);
    const bbPercent: number[] = new Array(period - 1).fill(NaN);
    
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = sma[i];
      const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      
      const upperBand = mean + deviation * stdDev;
      const lowerBand = mean - deviation * stdDev;
      
      const percentB = (closes[i] - lowerBand) / ((upperBand - lowerBand) || 1);
      bbPercent.push(percentB);
    }
    
    return bbPercent;
  }

  // Calculate all indicators for the data
  private calculateIndicators(closes: number[]): IndicatorData {
    return {
      rsi: this.calculateRSI(closes, 14),
      smaFast: this.calculateSMA(closes, 20),
      smaSlow: this.calculateSMA(closes, 50),
      emaFast: this.calculateEMA(closes, 12),
      emaSlow: this.calculateEMA(closes, 26),
      ...this.calculateMACD(closes),
      bbPercent: this.calculateBBPercent(closes, 20, 2),
    };
  }

  // Check if entry/exit condition is met at a specific index
  private checkConditionAtIndex(
    conditions: StrategyCondition[],
    indicators: IndicatorData,
    closes: number[],
    index: number
  ): boolean {
    if (!conditions || conditions.length === 0) return false;
    
    for (const cond of conditions) {
      const subfields = cond.subfields || {};
      const condition = subfields.Condition || subfields['MACD Trigger'];
      const targetValue = subfields['Signal Value'];
      
      let currentValue: number | undefined;
      let previousValue: number | undefined;
      let compareValue: number | undefined;
      let prevCompareValue: number | undefined;
      
      switch (cond.indicator) {
        case 'RSI': {
          const rsiLength = parseInt(subfields['RSI Length'] || '14');
          const rsi = this.calculateRSI(closes.slice(0, index + 1), rsiLength);
          currentValue = rsi[rsi.length - 1];
          previousValue = rsi.length > 1 ? rsi[rsi.length - 2] : undefined;
          break;
        }
        case 'MA': {
          const fastPeriod = parseInt(subfields['Fast MA'] || '20');
          const slowPeriod = parseInt(subfields['Slow MA'] || '50');
          const maType = subfields['MA Type'] || 'SMA';
          
          const closesSlice = closes.slice(0, index + 1);
          let fast: number[], slow: number[];
          
          if (maType === 'EMA') {
            fast = this.calculateEMA(closesSlice, fastPeriod);
            slow = this.calculateEMA(closesSlice, slowPeriod);
          } else {
            fast = this.calculateSMA(closesSlice, fastPeriod);
            slow = this.calculateSMA(closesSlice, slowPeriod);
          }
          
          currentValue = fast[fast.length - 1];
          previousValue = fast.length > 1 ? fast[fast.length - 2] : undefined;
          compareValue = slow[slow.length - 1];
          prevCompareValue = slow.length > 1 ? slow[slow.length - 2] : undefined;
          break;
        }
        case 'MACD': {
          const preset = subfields['MACD Preset'] || '12,26,9';
          const [fast, slow, signal] = preset.split(',').map(Number);
          const macd = this.calculateMACD(closes.slice(0, index + 1), fast, slow, signal);
          
          currentValue = macd.macdLine[macd.macdLine.length - 1];
          previousValue = macd.macdLine.length > 1 ? macd.macdLine[macd.macdLine.length - 2] : undefined;
          compareValue = macd.signalLine[macd.signalLine.length - 1];
          prevCompareValue = macd.signalLine.length > 1 ? macd.signalLine[macd.signalLine.length - 2] : undefined;
          
          // Check line trigger
          const lineTrigger = subfields['Line Trigger'];
          if (lineTrigger === 'Greater Than 0' && (currentValue ?? 0) <= 0) return false;
          if (lineTrigger === 'Less Than 0' && (currentValue ?? 0) >= 0) return false;
          break;
        }
        case 'BollingerBands': {
          const bbPeriod = parseInt(subfields['BB% Period'] || '20');
          const bbDeviation = parseFloat(subfields['Deviation'] || '2');
          const bb = this.calculateBBPercent(closes.slice(0, index + 1), bbPeriod, bbDeviation);
          
          currentValue = bb[bb.length - 1];
          previousValue = bb.length > 1 ? bb[bb.length - 2] : undefined;
          break;
        }
        default:
          continue;
      }
      
      if (currentValue === undefined || isNaN(currentValue)) return false;
      
      // For MA and MACD, compare fast to slow/signal
      if (cond.indicator === 'MA' || cond.indicator === 'MACD') {
        if (compareValue === undefined || isNaN(compareValue)) return false;
        
        switch (condition) {
          case 'Less Than':
            if (currentValue >= compareValue) return false;
            break;
          case 'Greater Than':
            if (currentValue <= compareValue) return false;
            break;
          case 'Crossing Up':
            if (previousValue === undefined || prevCompareValue === undefined) return false;
            if (!(previousValue <= prevCompareValue && currentValue > compareValue)) return false;
            break;
          case 'Crossing Down':
            if (previousValue === undefined || prevCompareValue === undefined) return false;
            if (!(previousValue >= prevCompareValue && currentValue < compareValue)) return false;
            break;
        }
      } else {
        // For RSI and BB, compare to target value
        switch (condition) {
          case 'Less Than':
            if (currentValue >= targetValue) return false;
            break;
          case 'Greater Than':
            if (currentValue <= targetValue) return false;
            break;
          case 'Crossing Up':
            if (previousValue === undefined) return false;
            if (!(previousValue <= targetValue && currentValue > targetValue)) return false;
            break;
          case 'Crossing Down':
            if (previousValue === undefined) return false;
            if (!(previousValue >= targetValue && currentValue < targetValue)) return false;
            break;
        }
      }
    }
    
    return true;
  }

  // Run backtest with REAL historical data
  async runBacktest(dto: RunBacktestDto): Promise<{
    status: string;
    message: string;
    metrics?: BacktestMetrics;
    trades?: TradeEvent[];
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
    const startDate = new Date(dto.start_date || Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = new Date(dto.end_date || Date.now());
    
    // Determine which conditions to use
    const entryConditions = dto.entry_conditions || dto.bullish_entry_conditions || [];
    const exitConditions = dto.exit_conditions || dto.bullish_exit_conditions || [];
    
    if (entryConditions.length === 0) {
      return {
        status: 'error',
        message: 'No entry conditions specified'
      };
    }
    
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
    
    // Process each trading pair
    for (const symbol of pairs) {
      try {
        // Fetch REAL historical data
        const data = await this.fetchHistoricalData(symbol, '1h', startDate, endDate);
        
        if (data.length < 50) {
          this.logger.warn(`Not enough data for ${symbol}: ${data.length} candles`);
          continue;
        }
        
        const closes = data.map(d => d.close);
        totalBars += data.length;
        
        // Iterate through each candle
        for (let i = 50; i < data.length; i++) {
          const candle = data[i];
          const price = candle.close;
          
          // Check for open position in this symbol
          const position = openPositions.get(symbol);
          
          if (position) {
            exposureBars++;
            
            // Check exit conditions
            if (this.checkConditionAtIndex(exitConditions, null as any, closes, i)) {
              // Close position
              const quantity = position.quantity;
              const profitLoss = (price - position.entryPrice) * quantity;
              const profitPercent = ((price - position.entryPrice) / position.entryPrice) * 100;
              
              balance += profitLoss;
              
              if (profitLoss > 0) {
                wins++;
                grossProfit += profitLoss;
              } else {
                losses++;
                grossLoss += Math.abs(profitLoss);
              }
              
              // Record exit trade
              trades.push({
                timestamp: candle.timestamp,
                symbol,
                action: 'SELL',
                price,
                quantity,
                amount: price * quantity,
                total_amount: baseOrderSize,
                profit_percent: profitPercent,
                move_from_entry: (price - position.entryPrice) / position.entryPrice,
                trade_id: `trade-${position.entryIndex}`,
                comment: `Exit: P/L ${profitPercent.toFixed(2)}%`,
                market_state: 'neutral'
              });
              
              openPositions.delete(symbol);
              
              // Update balance tracking
              if (balance > maxBalance) maxBalance = balance;
              const currentDrawdown = (maxBalance - balance) / maxBalance;
              if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
              
              balanceHistory.push({
                timestamp: candle.timestamp.toISOString(),
                balance: Math.round(balance * 100) / 100
              });
            }
          } else {
            // Check entry conditions
            if (openPositions.size < maxActiveDeals && 
                balance >= baseOrderSize &&
                this.checkConditionAtIndex(entryConditions, null as any, closes, i)) {
              
              // Open position
              tradeId++;
              const quantity = baseOrderSize / price;
              
              openPositions.set(symbol, {
                symbol,
                entryPrice: price,
                entryTime: candle.timestamp,
                quantity,
                entryIndex: tradeId
              });
              
              // Record entry trade
              trades.push({
                timestamp: candle.timestamp,
                symbol,
                action: 'BUY',
                price,
                quantity,
                amount: baseOrderSize,
                total_amount: baseOrderSize,
                profit_percent: 0,
                move_from_entry: 0,
                trade_id: `trade-${tradeId}`,
                comment: 'Entry signal',
                market_state: 'neutral'
              });
            }
          }
        }
        
        // Close any remaining open positions at end
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
            
            trades.push({
              timestamp: data[data.length - 1].timestamp,
              symbol,
              action: 'SELL',
              price: lastPrice,
              quantity: pos.quantity,
              amount: lastPrice * pos.quantity,
              total_amount: baseOrderSize,
              profit_percent: profitPercent,
              move_from_entry: (lastPrice - pos.entryPrice) / pos.entryPrice,
              trade_id: `trade-${pos.entryIndex}`,
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
    
    const netProfit = (balance - initialBalance) / initialBalance;
    const totalDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    const annualizedReturn = totalDays > 0 ? Math.pow(1 + netProfit, 365 / totalDays) - 1 : 0;
    
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
      net_profit: Math.round(netProfit * 10000) / 100,
      net_profit_usd: `$${Math.round((balance - initialBalance) * 100) / 100}`,
      total_profit: Math.round(netProfit * 10000) / 100,
      total_profit_usd: `$${Math.round((balance - initialBalance) * 100) / 100}`,
      max_drawdown: Math.round(maxDrawdown * 10000) / 100,
      max_realized_drawdown: Math.round(maxDrawdown * 10000) / 100,
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
        profit_percent: Math.round(t.profit_percent * 100) / 100
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
