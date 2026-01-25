import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { NotificationService } from './notification.service';

interface StrategyConfig {
  entry_conditions: any[];
  exit_conditions: any[];
  bullish_entry_conditions?: any[];
  bearish_entry_conditions?: any[];
  bullish_exit_conditions?: any[];
  bearish_exit_conditions?: any[];
  useMarketState?: boolean;
  timeframe?: string;
  realTrading?: boolean;
}

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);
  private runningStrategies: Map<number, NodeJS.Timeout> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeService: ExchangeService,
    private readonly notificationService: NotificationService,
  ) {}

  // ==================== STRATEGY CRUD ====================

  async createStrategy(
    userId: number,
    data: {
      name: string;
      description?: string;
      category?: string;
      config: StrategyConfig;
      pairs: string[];
      maxDeals?: number;
      orderSize?: number;
    },
  ) {
    return this.prisma.strategy.create({
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        config: JSON.stringify(data.config),
        pairs: JSON.stringify(data.pairs),
        maxDeals: data.maxDeals || 5,
        orderSize: data.orderSize || 1000,
        userId,
      },
    });
  }

  async getUserStrategies(userId: number) {
    return this.prisma.strategy.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        runs: {
          where: { status: 'running' },
          take: 1,
        },
      },
    });
  }

  async getStrategy(id: number, userId: number) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id, userId },
      include: {
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 5,
        },
        backtests: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!strategy) {
      throw new NotFoundException('Strategy not found');
    }

    return {
      ...strategy,
      config: JSON.parse(strategy.config),
      pairs: JSON.parse(strategy.pairs),
    };
  }

  async updateStrategy(
    id: number,
    userId: number,
    data: Partial<{
      name: string;
      description: string;
      category: string;
      config: StrategyConfig;
      pairs: string[];
      maxDeals: number;
      orderSize: number;
    }>,
  ) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id, userId },
    });

    if (!strategy) {
      throw new NotFoundException('Strategy not found');
    }

    return this.prisma.strategy.update({
      where: { id },
      data: {
        ...data,
        config: data.config ? JSON.stringify(data.config) : undefined,
        pairs: data.pairs ? JSON.stringify(data.pairs) : undefined,
      },
    });
  }

  async deleteStrategy(id: number, userId: number) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id, userId },
    });

    if (!strategy) {
      throw new NotFoundException('Strategy not found');
    }

    // Stop any running instances
    await this.stopStrategyRun(id, userId);

    return this.prisma.strategy.delete({
      where: { id },
    });
  }

  // ==================== STRATEGY RUNS (LIVE TRADING) ====================

  async startStrategyRun(
    strategyId: number,
    userId: number,
    initialBalance: number = 1000,
  ) {
    const strategy = await this.getStrategy(strategyId, userId);

    // Check if already running
    const existingRun = await this.prisma.strategyRun.findFirst({
      where: { strategyId, status: 'running' },
    });

    if (existingRun) {
      throw new BadRequestException('Strategy is already running');
    }

    // Create new run
    const run = await this.prisma.strategyRun.create({
      data: {
        config: JSON.stringify(strategy.config),
        pairs: JSON.stringify(strategy.pairs),
        exchange: 'binance',
        status: 'running',
        initialBalance,
        currentBalance: initialBalance,
        userId,
        strategyId,
      },
    });

    // Start the execution loop
    this.startExecutionLoop(run.id, strategy);

    return run;
  }

  async stopStrategyRun(strategyId: number, userId: number) {
    const run = await this.prisma.strategyRun.findFirst({
      where: {
        strategyId,
        userId,
        status: 'running',
      },
    });

    if (!run) {
      return { message: 'No running strategy found' };
    }

    // Stop the execution loop
    const timer = this.runningStrategies.get(run.id);
    if (timer) {
      clearInterval(timer);
      this.runningStrategies.delete(run.id);
    }

    // Update status
    return this.prisma.strategyRun.update({
      where: { id: run.id },
      data: {
        status: 'stopped',
        stoppedAt: new Date(),
      },
    });
  }

  async getRunningStrategies(userId: number) {
    return this.prisma.strategyRun.findMany({
      where: {
        userId,
        status: 'running',
      },
      include: {
        strategy: true,
        trades: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  async getStrategyRunHistory(strategyId: number, userId: number) {
    return this.prisma.strategyRun.findMany({
      where: { strategyId, userId },
      orderBy: { startedAt: 'desc' },
      include: {
        trades: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  // ==================== EXECUTION LOOP ====================

  private startExecutionLoop(runId: number, strategy: any) {
    const intervalMs = 60000; // Check every minute

    const timer = setInterval(async () => {
      try {
        await this.executeStrategyTick(runId, strategy);
      } catch (error) {
        this.logger.error(`Strategy run ${runId} error: ${error.message}`);
        await this.prisma.strategyRun.update({
          where: { id: runId },
          data: {
            lastError: error.message,
            errorCount: { increment: 1 },
          },
        });
      }
    }, intervalMs);

    this.runningStrategies.set(runId, timer);
    this.logger.log(`Started strategy run ${runId}`);
  }

  private async executeStrategyTick(runId: number, strategy: any) {
    const run = await this.prisma.strategyRun.findUnique({
      where: { id: runId },
      include: { trades: true },
    });

    if (!run || run.status !== 'running') {
      const timer = this.runningStrategies.get(runId);
      if (timer) {
        clearInterval(timer);
        this.runningStrategies.delete(runId);
      }
      return;
    }

    const config = JSON.parse(run.config) as StrategyConfig;
    const pairs = JSON.parse(run.pairs) as string[];

    // Get exchange connection
    let exchange;
    try {
      exchange = this.exchangeService.getConnection('binance');
    } catch {
      this.logger.warn(`No exchange connected for run ${runId}`);
      return;
    }

    // Check each pair for signals
    for (const symbol of pairs) {
      try {
        await this.checkSignals(run, symbol, config, exchange.instance);
      } catch (error) {
        this.logger.error(`Error checking ${symbol}: ${error.message}`);
      }
    }
  }

  private async checkSignals(
    run: any,
    symbol: string,
    config: StrategyConfig,
    exchange: any,
  ) {
    // Use live data from Contabo server (same indicators as backtest)
    // Fallback to exchange API if server unavailable
    let indicators: any;
    let currentPrice: number;

    try {
      // Try to get pre-calculated indicators from Contabo
      const response = await fetch(
        `http://144.91.86.94:5555/data/${symbol.replace('/', '_')}_live.parquet`,
      );
      if (response.ok) {
        const data = await response.json();
        indicators = data.indicators;
        currentPrice = data.close;
        this.logger.log(`Using live data for ${symbol}: RSI=${indicators.rsi_14?.toFixed(1)}`);
      } else {
        throw new Error('Live data unavailable');
      }
    } catch {
      // Fallback: Calculate from exchange data
      const timeframe = config.timeframe || '1h';
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 200);
      if (!ohlcv || ohlcv.length < 50) return;

      const closes = ohlcv.map((c: any[]) => c[4]);
      const highs = ohlcv.map((c: any[]) => c[2]);
      const lows = ohlcv.map((c: any[]) => c[3]);
      currentPrice = closes[closes.length - 1];
      indicators = this.calculateAllIndicators(closes, highs, lows);
      this.logger.log(`Using exchange data for ${symbol} (fallback)`);
    }

    indicators.price = currentPrice;

    // Check if we have an open position
    const openTrade = await this.prisma.trade.findFirst({
      where: {
        strategyRunId: run.id,
        symbol,
        status: 'filled',
        exitPrice: null,
      },
    });

    // Check entry conditions (ALL must be true)
    if (
      !openTrade &&
      this.checkConditions(config.entry_conditions || [], indicators)
    ) {
      await this.executeTrade(run, symbol, 'buy', currentPrice, exchange, config.realTrading);
    }

    // Check exit conditions (ALL must be true)
    if (
      openTrade &&
      this.checkConditions(config.exit_conditions || [], indicators)
    ) {
      await this.closeTrade(run, openTrade, currentPrice, exchange, config.realTrading);
    }
  }

  private calculateAllIndicators(closes: number[], highs: number[], lows: number[]) {
    const indicators: any = {};
    
    // RSI for different periods
    indicators.rsi_7 = this.calculateRSI(closes, 7).slice(-1)[0];
    indicators.rsi_14 = this.calculateRSI(closes, 14).slice(-1)[0];
    indicators.rsi_21 = this.calculateRSI(closes, 21).slice(-1)[0];
    indicators.rsi = indicators.rsi_14; // Default
    
    // EMA for different periods
    indicators.ema_9 = this.calculateEMA(closes, 9).slice(-1)[0];
    indicators.ema_20 = this.calculateEMA(closes, 20).slice(-1)[0];
    indicators.ema_50 = this.calculateEMA(closes, 50).slice(-1)[0];
    indicators.ema_100 = this.calculateEMA(closes, 100).slice(-1)[0];
    indicators.ema_200 = this.calculateEMA(closes, 200).slice(-1)[0];
    
    // SMA
    indicators.sma_20 = this.calculateSMA(closes, 20);
    indicators.sma_50 = this.calculateSMA(closes, 50);
    indicators.sma_100 = this.calculateSMA(closes, 100);
    
    // Bollinger Bands
    const bb20 = this.calculateBollingerBands(closes, 20, 2);
    indicators.bb_upper_20 = bb20.upper;
    indicators.bb_lower_20 = bb20.lower;
    indicators.bb_pct_20 = bb20.pctB;
    
    const bb50 = this.calculateBollingerBands(closes, 50, 1);
    indicators.bb_pct_50 = bb50.pctB;
    
    return indicators;
  }

  private checkConditions(conditions: any[], indicators: any): boolean {
    if (!conditions || conditions.length === 0) return false;

    // ALL conditions must be true
    for (const cond of conditions) {
      const indicator = cond.indicator;
      const subfields = cond.subfields || {};
      const condition = subfields.Condition;
      
      let indicatorValue: number;
      let targetValue: number;

      if (indicator === 'RSI') {
        const period = subfields['RSI Length'] || 14;
        indicatorValue = indicators[`rsi_${period}`] || indicators.rsi;
        targetValue = subfields['Signal Value'] || 30;
      } else if (indicator === 'MA') {
        const maType = subfields['MA Type'] || 'EMA';
        const fastPeriod = subfields['Fast MA'] || 20;
        const slowPeriod = subfields['Slow MA'] || 100;
        const fastKey = `${maType.toLowerCase()}_${fastPeriod}`;
        const slowKey = `${maType.toLowerCase()}_${slowPeriod}`;
        indicatorValue = indicators[fastKey] || 0;
        targetValue = indicators[slowKey] || 0;
      } else if (indicator === 'BollingerBands') {
        const period = subfields['BB% Period'] || 20;
        indicatorValue = indicators[`bb_pct_${period}`] || indicators.bb_pct_20;
        targetValue = subfields['Signal Value'] || 0.1;
      } else {
        continue; // Unknown indicator, skip
      }

      // Check condition
      if (condition === 'Less Than' && indicatorValue >= targetValue) return false;
      if (condition === 'Greater Than' && indicatorValue <= targetValue) return false;
      if (condition === 'Crossing Up') {
        // Would need previous value - simplified check
        if (indicatorValue <= targetValue) return false;
      }
      if (condition === 'Crossing Down') {
        if (indicatorValue >= targetValue) return false;
      }
    }
    return true;
  }

  private calculateEMA(closes: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const ema: number[] = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
      ema.push(closes[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  private calculateSMA(closes: number[], period: number): number {
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private calculateBollingerBands(closes: number[], period: number, dev: number) {
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / slice.length;
    const std = Math.sqrt(variance);
    const upper = sma + dev * std;
    const lower = sma - dev * std;
    const currentPrice = closes[closes.length - 1];
    const pctB = (currentPrice - lower) / (upper - lower);
    return { upper, lower, sma, pctB };
  }

  private async executeTrade(
    run: any,
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    exchange: any,
    realTrading: boolean = false,
  ) {
    const quantity = (run.initialBalance * 0.1) / price; // 10% position size

    try {
      let orderId = null;
      let actualPrice = price;

      // REAL TRADING - execute on exchange
      if (realTrading) {
        this.logger.log(`🔴 REAL TRADE: ${side.toUpperCase()} ${quantity.toFixed(6)} ${symbol} @ market`);
        const order = await exchange.createOrder(symbol, 'market', side, quantity);
        orderId = order.id;
        actualPrice = order.average || order.price || price;
        this.logger.log(`✅ Order filled: ${orderId} at ${actualPrice}`);
      } else {
        this.logger.log(`📝 PAPER TRADE: ${side.toUpperCase()} ${quantity.toFixed(6)} ${symbol} @ ${price}`);
      }

      const trade = await this.prisma.trade.create({
        data: {
          symbol,
          side,
          type: 'market',
          quantity,
          price: actualPrice,
          amount: quantity * actualPrice,
          status: 'filled',
          entryPrice: actualPrice,
          comment: realTrading ? `Real order: ${orderId}` : 'Paper trade',
          executedAt: new Date(),
          userId: run.userId,
          strategyRunId: run.id,
        },
      });

      // Update run stats
      await this.prisma.strategyRun.update({
        where: { id: run.id },
        data: {
          totalTrades: { increment: 1 },
        },
      });

      this.logger.log(`Executed ${side} on ${symbol} at ${actualPrice}`);
      return trade;
    } catch (error) {
      this.logger.error(`Failed to execute trade: ${error.message}`);
      throw error;
    }
  }

  private async closeTrade(
    run: any,
    trade: any,
    exitPrice: number,
    exchange: any,
    realTrading: boolean = false,
  ) {
    let actualExitPrice = exitPrice;

    // REAL TRADING - sell on exchange
    if (realTrading) {
      try {
        this.logger.log(`🔴 REAL CLOSE: SELL ${trade.quantity} ${trade.symbol} @ market`);
        const order = await exchange.createOrder(trade.symbol, 'market', 'sell', trade.quantity);
        actualExitPrice = order.average || order.price || exitPrice;
        this.logger.log(`✅ Sell order filled at ${actualExitPrice}`);
      } catch (error) {
        this.logger.error(`Failed to close position: ${error.message}`);
        throw error;
      }
    } else {
      this.logger.log(`📝 PAPER CLOSE: SELL ${trade.quantity} ${trade.symbol} @ ${exitPrice}`);
    }

    const profitLoss = (actualExitPrice - trade.entryPrice) * trade.quantity;
    const profitPercent =
      ((actualExitPrice - trade.entryPrice) / trade.entryPrice) * 100;

    await this.prisma.trade.update({
      where: { id: trade.id },
      data: {
        exitPrice: actualExitPrice,
        profitLoss,
        profitPercent,
        status: 'closed',
      },
    });

    // Update run stats
    const isWin = profitLoss > 0;
    await this.prisma.strategyRun.update({
      where: { id: run.id },
      data: {
        currentBalance: { increment: profitLoss },
        totalProfit: { increment: profitLoss },
        winningTrades: isWin ? { increment: 1 } : undefined,
      },
    });

    this.logger.log(
      `Closed trade on ${trade.symbol}: ${profitPercent.toFixed(2)}% ($${profitLoss.toFixed(2)})`,
    );
  }

  private calculateRSI(closes: number[], period: number = 14): number[] {
    if (closes.length < period + 1) return [];

    const rsi: number[] = [];
    let gains = 0,
      losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgGain / (avgLoss || 1e-9);
    rsi.push(100 - 100 / (1 + rs));

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

  // ==================== SAVE BACKTEST AS STRATEGY ====================

  async saveBacktestAsStrategy(
    userId: number,
    data: {
      name: string;
      description?: string;
      config: StrategyConfig;
      pairs: string[];
      maxDeals?: number;
      orderSize?: number;
      backtestMetrics: {
        netProfit: number;
        maxDrawdown: number;
        sharpeRatio: number;
        winRate: number;
      };
    },
  ) {
    return this.prisma.strategy.create({
      data: {
        name: data.name,
        description: data.description,
        category: 'Custom',
        config: JSON.stringify(data.config),
        pairs: JSON.stringify(data.pairs),
        maxDeals: data.maxDeals || 5,
        orderSize: data.orderSize || 1000,
        lastBacktestProfit: data.backtestMetrics.netProfit,
        lastBacktestDrawdown: data.backtestMetrics.maxDrawdown,
        lastBacktestSharpe: data.backtestMetrics.sharpeRatio,
        lastBacktestWinRate: data.backtestMetrics.winRate,
        userId,
      },
    });
  }

  // ==================== DASHBOARD STATS ====================

  async getDashboardStats(userId: number) {
    const [strategies, runningCount, totalTrades, recentTrades] =
      await Promise.all([
        this.prisma.strategy.count({ where: { userId } }),
        this.prisma.strategyRun.count({ where: { userId, status: 'running' } }),
        this.prisma.trade.count({ where: { userId } }),
        this.prisma.trade.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    // Calculate total P&L
    const pnlResult = await this.prisma.trade.aggregate({
      where: { userId, profitLoss: { not: null } },
      _sum: { profitLoss: true },
    });

    // Get performance over time
    const runs = await this.prisma.strategyRun.findMany({
      where: { userId },
      select: {
        startedAt: true,
        totalProfit: true,
        totalTrades: true,
        winningTrades: true,
      },
    });

    return {
      totalStrategies: strategies,
      runningStrategies: runningCount,
      totalTrades,
      totalProfitLoss: pnlResult._sum.profitLoss || 0,
      recentTrades,
      runs,
    };
  }
}
