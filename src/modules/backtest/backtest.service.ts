import { Injectable, Logger } from '@nestjs/common';
import { RunBacktestDto, StrategyCondition } from './dto/backtest.dto';
import { PrismaService } from '../../prisma/prisma.service';

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
  rsi_14?: number;
  sma_20?: number;
  sma_50?: number;
  macd?: number;
  macd_signal?: number;
  bb_upper?: number;
  bb_lower?: number;
  bb_percent?: number;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  // Calculate RSI
  private calculateRSI(closes: number[], period: number = 14): number[] {
    if (closes.length < period + 1) return [];
    
    const rsi: number[] = [];
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
    const sma: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    return sma;
  }

  // Calculate EMA
  private calculateEMA(values: number[], period: number): number[] {
    const ema: number[] = [];
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
    const offset = slow - fast;
    
    for (let i = 0; i < emaSlow.length; i++) {
      macdLine.push(emaFast[i + offset] - emaSlow[i]);
    }
    
    const signalLine = this.calculateEMA(macdLine, signal);
    
    return { macdLine, signalLine };
  }

  // Calculate Bollinger Bands %B
  private calculateBBPercent(closes: number[], period = 20, deviation = 2): number[] {
    const sma = this.calculateSMA(closes, period);
    const bbPercent: number[] = [];
    
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = sma[i - period + 1];
      const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      
      const upperBand = mean + deviation * stdDev;
      const lowerBand = mean - deviation * stdDev;
      
      // %B = (Price - Lower Band) / (Upper Band - Lower Band)
      const percentB = (closes[i] - lowerBand) / (upperBand - lowerBand || 1);
      bbPercent.push(percentB);
    }
    
    return bbPercent;
  }

  // Check if condition is met
  private checkCondition(
    currentValue: number,
    previousValue: number | null,
    condition: string,
    targetValue: number
  ): boolean {
    switch (condition) {
      case 'Less Than':
        return currentValue < targetValue;
      case 'Greater Than':
        return currentValue > targetValue;
      case 'Crossing Up':
        if (previousValue === null) return false;
        return previousValue <= targetValue && currentValue > targetValue;
      case 'Crossing Down':
        if (previousValue === null) return false;
        return previousValue >= targetValue && currentValue < targetValue;
      default:
        return false;
    }
  }

  // Run a simulated backtest (for demo purposes)
  async runBacktest(dto: RunBacktestDto): Promise<{
    status: string;
    message: string;
    metrics?: BacktestMetrics;
    trades?: any[];
    chartData?: any;
  }> {
    this.logger.log(`Running backtest: ${dto.strategy_name}`);
    
    const pairs = dto.pairs || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    const initialBalance = dto.initial_balance || 5000;
    const maxActiveDeals = dto.max_active_deals || 5;
    const baseOrderSize = dto.base_order_size || 1000;
    
    // Generate simulated data for demo
    const trades: TradeEvent[] = [];
    let balance = initialBalance;
    let maxBalance = initialBalance;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    
    // Simulate some trades based on conditions
    const numSimulatedTrades = Math.floor(Math.random() * 30) + 20;
    const startDate = new Date(dto.start_date || Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = new Date(dto.end_date || Date.now());
    const timeRange = endDate.getTime() - startDate.getTime();
    
    const balanceHistory: { timestamp: string; balance: number }[] = [];
    
    for (let i = 0; i < numSimulatedTrades; i++) {
      const symbol = pairs[Math.floor(Math.random() * pairs.length)];
      const entryTime = new Date(startDate.getTime() + (timeRange * i) / numSimulatedTrades);
      const exitTime = new Date(entryTime.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000);
      
      const entryPrice = 30000 + Math.random() * 10000;
      const priceChange = (Math.random() - 0.45) * 0.1; // Slight positive bias
      const exitPrice = entryPrice * (1 + priceChange);
      
      const quantity = baseOrderSize / entryPrice;
      const profitLoss = (exitPrice - entryPrice) * quantity * 0.999; // Include fees
      
      balance += profitLoss;
      if (balance > maxBalance) maxBalance = balance;
      const currentDrawdown = (maxBalance - balance) / maxBalance;
      if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
      
      if (profitLoss > 0) {
        wins++;
        grossProfit += profitLoss;
      } else {
        losses++;
        grossLoss += Math.abs(profitLoss);
      }
      
      // Entry trade
      trades.push({
        timestamp: entryTime,
        symbol,
        action: 'BUY',
        price: entryPrice,
        quantity,
        amount: baseOrderSize,
        total_amount: baseOrderSize,
        profit_percent: 0,
        move_from_entry: 0,
        trade_id: `trade-${i + 1}`,
        comment: 'Entry signal',
        market_state: Math.random() > 0.5 ? 'bullish' : 'bearish'
      });
      
      // Exit trade
      trades.push({
        timestamp: exitTime,
        symbol,
        action: 'SELL',
        price: exitPrice,
        quantity,
        amount: exitPrice * quantity,
        total_amount: baseOrderSize,
        profit_percent: priceChange * 100,
        move_from_entry: priceChange,
        trade_id: `trade-${i + 1}`,
        comment: 'Exit signal',
        market_state: Math.random() > 0.5 ? 'bullish' : 'bearish'
      });
      
      balanceHistory.push({
        timestamp: exitTime.toISOString(),
        balance: Math.round(balance * 100) / 100
      });
    }
    
    const totalTrades = wins + losses;
    const netProfit = (balance - initialBalance) / initialBalance;
    const totalDays = timeRange / (24 * 60 * 60 * 1000);
    const annualizedReturn = totalDays > 0 ? Math.pow(1 + netProfit, 365 / totalDays) - 1 : 0;
    
    // Calculate Sharpe ratio (simplified)
    const dailyReturns = balanceHistory.map((b, i) => 
      i === 0 ? 0 : (b.balance - balanceHistory[i-1].balance) / balanceHistory[i-1].balance
    ).slice(1);
    
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
      exposure_time_frac: Math.round(Math.random() * 50 + 20) // Placeholder
    };
    
    const chartData = {
      timestamps: balanceHistory.map(b => b.timestamp),
      balance: balanceHistory.map(b => b.balance),
      drawdown: balanceHistory.map((b, i) => {
        const maxSoFar = Math.max(...balanceHistory.slice(0, i + 1).map(x => x.balance));
        return Math.round(((maxSoFar - b.balance) / maxSoFar) * 10000) / 100;
      })
    };
    
    return {
      status: 'success',
      message: `Backtest completed: ${totalTrades} trades executed`,
      metrics,
      trades: trades.map(t => ({
        ...t,
        timestamp: t.timestamp.toISOString(),
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

