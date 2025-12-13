import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';

interface StrategyConfig {
  entry_conditions: any[];
  exit_conditions: any[];
  bullish_entry_conditions?: any[];
  bearish_entry_conditions?: any[];
  bullish_exit_conditions?: any[];
  bearish_exit_conditions?: any[];
  useMarketState?: boolean;
}

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);
  private runningStrategies: Map<number, NodeJS.Timeout> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeService: ExchangeService,
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
    // Fetch current market data
    const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
    if (!ohlcv || ohlcv.length < 20) return;

    const closes = ohlcv.map((c: any[]) => c[4]);
    const currentPrice = closes[closes.length - 1];

    // Calculate indicators
    const rsi = this.calculateRSI(closes, 14);
    const currentRSI = rsi[rsi.length - 1];

    // Check if we have an open position
    const openTrade = await this.prisma.trade.findFirst({
      where: {
        strategyRunId: run.id,
        symbol,
        status: 'filled',
        exitPrice: null,
      },
    });

    // Check entry conditions
    if (
      !openTrade &&
      this.checkConditions(config.entry_conditions || [], {
        rsi: currentRSI,
        price: currentPrice,
      })
    ) {
      await this.executeTrade(run, symbol, 'buy', currentPrice, exchange);
    }

    // Check exit conditions
    if (
      openTrade &&
      this.checkConditions(config.exit_conditions || [], {
        rsi: currentRSI,
        price: currentPrice,
      })
    ) {
      await this.closeTrade(run, openTrade, currentPrice, exchange);
    }
  }

  private checkConditions(
    conditions: any[],
    indicators: { rsi: number; price: number },
  ): boolean {
    if (!conditions || conditions.length === 0) return false;

    for (const cond of conditions) {
      if (cond.indicator === 'RSI') {
        const value = cond.subfields?.['Signal Value'];
        const condition = cond.subfields?.Condition;

        if (condition === 'Less Than' && indicators.rsi >= value) return false;
        if (condition === 'Greater Than' && indicators.rsi <= value)
          return false;
      }
    }
    return true;
  }

  private async executeTrade(
    run: any,
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    exchange: any,
  ) {
    const quantity = (run.initialBalance * 0.1) / price; // 10% position size

    try {
      // Create order on exchange (paper trading for now)
      // const order = await exchange.createOrder(symbol, 'market', side, quantity);

      const trade = await this.prisma.trade.create({
        data: {
          symbol,
          side,
          type: 'market',
          quantity,
          price,
          amount: quantity * price,
          status: 'filled',
          entryPrice: price,
          comment: 'Strategy signal',
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

      this.logger.log(`Executed ${side} on ${symbol} at ${price}`);
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
  ) {
    const profitLoss = (exitPrice - trade.entryPrice) * trade.quantity;
    const profitPercent =
      ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;

    await this.prisma.trade.update({
      where: { id: trade.id },
      data: {
        exitPrice,
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
      `Closed trade on ${trade.symbol}: ${profitPercent.toFixed(2)}%`,
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
