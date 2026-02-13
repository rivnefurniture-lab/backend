import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { StartStrategyDto } from './dto/start-strategy.dto';
import { StopStrategyDto } from './dto/stop-strategy.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { DataServerService } from '../data-server/data-server.service';
import { Exchange } from 'ccxt';
import * as path from 'path';
import { checkAllConditions as sharedCheckAllConditions } from '../../engine/conditions';

interface ActiveJob {
  id: string;
  runId: number;
  strategyId: number;
  userId: number;
  exchange: string;
  exchangeInstance: Exchange;
  symbols: string[];
  config: any;
  orderSize: number;
  maxBudget: number;
  timer: NodeJS.Timeout;
  status: 'running' | 'paused' | 'error';
  stats: {
    trades: number;
    wins: number;
    profit: number;
    unrealizedPnL: number;
    lastCheck: Date;
  };
}

@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);
  private jobs: Map<string, ActiveJob> = new Map();
  private userIdCache: Map<string, { id: number; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly staticDir = path.join(process.cwd(), 'static');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataServer: DataServerService,
  ) {
    this.logger.log('StrategiesService initialized');
    this.checkDataServerConnection();
  }

  private async checkDataServerConnection() {
    const healthy = await this.dataServer.isHealthy();
    if (healthy) {
      this.logger.log('✅ Contabo data server connected');
    } else {
      this.logger.warn(
        '⚠️ Contabo data server not available - live trading may not work',
      );
    }
  }

  // Resolve userId (supabaseId string -> numeric id)
  private async resolveUserId(userId: number | string): Promise<number> {
    if (typeof userId === 'number') return userId;

    const cached = this.userIdCache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.id;
    }

    try {
      let user = await this.prisma.user.findFirst({
        where: { supabaseId: userId },
        select: { id: true },
      });

      if (!user) {
        user = await this.prisma.user.create({
          data: {
            supabaseId: userId,
            email: `user-${userId.substring(0, 8)}@temp.local`,
            xp: 0,
            level: 1,
          },
          select: { id: true },
        });
      }

      this.userIdCache.set(userId, { id: user.id, timestamp: Date.now() });
      return user.id;
    } catch (e: any) {
      this.logger.error(`Failed to resolve userId: ${e.message}`);
      if (cached) return cached.id;
      throw new BadRequestException('Could not resolve user');
    }
  }

  // Previous data for crossing detection in live trading
  private prevDataBySymbol: Map<string, Record<string, any>> = new Map();

  /**
   * Check all conditions using the shared engine (same logic as backtest).
   * This ensures live trading signals are identical to backtest signals.
   */
  private checkAllConditions(
    data: Record<string, any>,
    conditions: any[],
    symbol?: string,
  ): boolean {
    const prevData = symbol ? this.prevDataBySymbol.get(symbol) || null : null;
    const result = sharedCheckAllConditions(data, prevData, conditions);
    if (symbol) this.prevDataBySymbol.set(symbol, { ...data });
    return result;
  }

  // Get user's strategies
  async getUserStrategies(userId: number | string) {
    const numericUserId = await this.resolveUserId(userId);
    return this.prisma.strategy.findMany({
      where: { userId: numericUserId },
      select: {
        id: true,
        name: true,
        pairs: true,
        isActive: true,
        config: true,
        createdAt: true,
        runs: {
          take: 5,
          orderBy: { startedAt: 'desc' },
          select: {
            id: true,
            status: true,
            totalProfit: true,
            totalTrades: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Save a new strategy
  async saveStrategy(
    userId: number | string,
    data: {
      name: string;
      pairs: string[] | string;
      config: any;
      description?: string;
      category?: string;
      orderSize?: number;
    },
  ) {
    const numericUserId = await this.resolveUserId(userId);
    const pairsStr = Array.isArray(data.pairs)
      ? data.pairs.join(',')
      : data.pairs;
    const configStr =
      typeof data.config === 'string'
        ? data.config
        : JSON.stringify(data.config);

    return this.prisma.strategy.create({
      data: {
        userId: numericUserId,
        name: data.name,
        description: data.description,
        category: data.category,
        pairs: pairsStr,
        config: configStr,
        orderSize: data.orderSize || 100,
        isActive: false,
        isPublic: false, // User strategies are private by default
      },
    });
  }

  // Update strategy
  async updateStrategy(
    userId: number | string,
    strategyId: number,
    updates: any,
  ) {
    const numericUserId = await this.resolveUserId(userId);
    return this.prisma.strategy.update({
      where: { id: strategyId, userId: numericUserId },
      data: updates,
    });
  }

  // Delete strategy
  async deleteStrategy(userId: number | string, strategyId: number) {
    const numericUserId = await this.resolveUserId(userId);

    // Delete trades first, then runs, then strategy
    await this.prisma.trade.deleteMany({
      where: { strategyRun: { strategyId, userId: numericUserId } },
    });
    await this.prisma.strategyRun.deleteMany({
      where: { strategyId, userId: numericUserId },
    });
    return this.prisma.strategy.delete({
      where: { id: strategyId, userId: numericUserId },
    });
  }

  // Start live trading
  async startStrategy(
    userId: number | string,
    strategyId: number | string,
    exchange: Exchange,
    exchangeName: string,
    pairs: string[],
    config: any,
    orderSize: number = 10,
    maxBudget: number = 100,
  ) {
    const numericUserId = await this.resolveUserId(userId);
    let dbStrategyId: number;
    const pairsStr = pairs.join(',');
    const configStr =
      typeof config === 'string' ? config : JSON.stringify(config);

    // Create or find strategy in DB
    if (typeof strategyId === 'string' && strategyId.includes('-')) {
      // Preset strategy - create a DB entry
      const existing = await this.prisma.strategy.findFirst({
        where: { userId: numericUserId, name: strategyId },
      });

      if (existing) {
        dbStrategyId = existing.id;
      } else {
        const created = await this.prisma.strategy.create({
          data: {
            userId: numericUserId,
            name: strategyId,
            pairs: pairsStr,
            config: configStr,
            orderSize,
            isActive: true,
          },
        });
        dbStrategyId = created.id;
      }
    } else {
      dbStrategyId =
        typeof strategyId === 'number' ? strategyId : parseInt(strategyId);
    }

    // Create strategy run
    const run = await this.prisma.strategyRun.create({
      data: {
        strategyId: dbStrategyId,
        userId: numericUserId,
        exchange: exchangeName,
        status: 'running',
        pairs: pairsStr,
        initialBalance: orderSize * pairs.length,
        totalTrades: 0,
        winningTrades: 0,
        totalProfit: 0,
        config: configStr,
      },
    });

    // Mark strategy as active
    await this.prisma.strategy.update({
      where: { id: dbStrategyId },
      data: { isActive: true },
    });

    // Create job
    const jobId = `run_${run.id}`;
    const job: ActiveJob = {
      id: jobId,
      runId: run.id,
      strategyId: dbStrategyId,
      userId: numericUserId,
      exchange: exchangeName,
      exchangeInstance: exchange,
      symbols: pairs,
      config,
      orderSize: Math.max(orderSize, 10),
      maxBudget,
      timer: setInterval(() => this.executeTradingTick(job, exchange), 60000),
      status: 'running',
      stats: {
        trades: 0,
        wins: 0,
        profit: 0,
        unrealizedPnL: 0,
        lastCheck: new Date(),
      },
    };

    this.jobs.set(jobId, job);
    this.logger.log(`Started strategy ${dbStrategyId} (run ${run.id})`);

    // Execute first tick immediately
    setTimeout(() => this.executeTradingTick(job, exchange), 1000);

    return { runId: run.id, strategyId: dbStrategyId, status: 'running' };
  }

  // Execute trading tick - reads from parquet files
  private async executeTradingTick(job: ActiveJob, exchange: Exchange) {
    try {
      const config = job.config;
      const entryConditions =
        config.entry_conditions || config.bullish_entry_conditions || [];
      const exitConditions =
        config.exit_conditions || config.bullish_exit_conditions || [];

      for (const symbol of job.symbols) {
        try {
          // Read latest data from Contabo data server
          const data = await this.dataServer.getLatestData(symbol);
          if (!data) {
            this.logger.warn(`[${job.id}] No data for ${symbol} from data server`);
            continue;
          }

          const currentPrice = data.close;
          this.logger.log(
            `[${job.id}] ${symbol} Price: $${currentPrice}, RSI_14: ${data.RSI_14?.toFixed(2)}`,
          );

          // Check for open position
          const openTrade = await this.prisma.trade.findFirst({
            where: {
              strategyRunId: job.runId,
              symbol,
              side: 'buy',
              status: 'filled',
              exitPrice: null,
            },
          });

          if (!openTrade) {
            // Check entry conditions (using shared engine for identical logic to backtest)
            const shouldEnter = this.checkAllConditions(data, entryConditions, symbol);

            if (shouldEnter) {
              await this.executeBuy(job, exchange, symbol, currentPrice);
            }
          } else {
            // Check exit conditions
            let shouldExit = false;

            // Check TIME_ELAPSED first
            const timeCondition = exitConditions.find(
              (c: any) => c.indicator === 'TIME_ELAPSED',
            );
            if (timeCondition) {
              const minutesRequired = timeCondition.subfields?.minutes || 5;
              const entryTime = openTrade.executedAt || openTrade.createdAt;
              const minutesSinceEntry =
                (Date.now() - new Date(entryTime).getTime()) / 60000;
              shouldExit = minutesSinceEntry >= minutesRequired;
            } else {
              shouldExit = this.checkAllConditions(data, exitConditions, symbol);
            }

            if (shouldExit) {
              await this.executeSell(job, exchange, openTrade, currentPrice);
            }
          }
        } catch (err: any) {
          this.logger.error(
            `[${job.id}] Error processing ${symbol}: ${err.message}`,
          );
        }
      }

      job.stats.lastCheck = new Date();
    } catch (err: any) {
      this.logger.error(`[${job.id}] Tick error: ${err.message}`);
      job.status = 'error';
    }
  }

  // Execute buy order
  private async executeBuy(
    job: ActiveJob,
    exchange: Exchange,
    symbol: string,
    price: number,
  ) {
    const quantity = job.orderSize / price;
    const preciseQty = String(
      exchange.amountToPrecision(symbol, quantity) || quantity,
    );

    let orderId: string | undefined;
    let actualPrice = price;
    let actualQty = Number(preciseQty);

    try {
      this.logger.log(`[${job.id}] BUY ${preciseQty} ${symbol}`);
      const order: any = await (exchange as any).createOrder(
        symbol,
        'market',
        'buy',
        preciseQty,
      );
      orderId = order.id;
      actualPrice = order.average || order.price || price;
      actualQty = order.filled || actualQty;
    } catch (err: any) {
      this.logger.error(`[${job.id}] Buy failed: ${err.message}`);
    }

    await this.prisma.trade.create({
      data: {
        userId: job.userId,
        strategyRunId: job.runId,
        symbol,
        side: 'buy',
        type: 'market',
        quantity: actualQty,
        price: actualPrice,
        amount: actualQty * actualPrice,
        entryPrice: actualPrice,
        status: orderId ? 'filled' : 'failed',
        orderId,
        executedAt: new Date(),
        comment: orderId ? 'Entry signal' : 'Entry failed',
      },
    });

    job.stats.trades++;
    await this.prisma.strategyRun.update({
      where: { id: job.runId },
      data: { totalTrades: job.stats.trades },
    });
  }

  // Execute sell order
  private async executeSell(
    job: ActiveJob,
    exchange: Exchange,
    trade: any,
    price: number,
  ) {
    let orderId: string | undefined;
    let actualPrice = price;

    try {
      const preciseQty = String(
        exchange.amountToPrecision(trade.symbol, trade.quantity) ||
          trade.quantity,
      );
      this.logger.log(`[${job.id}] SELL ${preciseQty} ${trade.symbol}`);
      const order: any = await (exchange as any).createOrder(
        trade.symbol,
        'market',
        'sell',
        preciseQty,
      );
      orderId = order.id;
      actualPrice = order.average || order.price || price;
    } catch (err: any) {
      this.logger.error(`[${job.id}] Sell failed: ${err.message}`);
    }

    const profitLoss = (actualPrice - trade.entryPrice) * trade.quantity;
    const profitPercent =
      ((actualPrice - trade.entryPrice) / trade.entryPrice) * 100;

    await this.prisma.trade.update({
      where: { id: trade.id },
      data: {
        exitPrice: actualPrice,
        profitLoss,
        profitPercent,
        comment: 'Exit signal',
      },
    });

    // Create sell trade record
    await this.prisma.trade.create({
      data: {
        userId: job.userId,
        strategyRunId: job.runId,
        symbol: trade.symbol,
        side: 'sell',
        type: 'market',
        quantity: trade.quantity,
        price: actualPrice,
        amount: trade.quantity * actualPrice,
        entryPrice: trade.entryPrice,
        exitPrice: actualPrice,
        profitLoss,
        profitPercent,
        status: orderId ? 'filled' : 'failed',
        orderId,
        executedAt: new Date(),
        comment: `Closed (P/L: $${profitLoss.toFixed(2)})`,
      },
    });

    job.stats.trades++;
    job.stats.profit += profitLoss;
    if (profitLoss > 0) job.stats.wins++;

    await this.prisma.strategyRun.update({
      where: { id: job.runId },
      data: {
        totalTrades: job.stats.trades,
        winningTrades: job.stats.wins,
        totalProfit: job.stats.profit,
      },
    });
  }

  // Stop job helper
  private stopJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (job) {
      clearInterval(job.timer);
      this.jobs.delete(jobId);
    }
  }

  // Stop strategy and close positions
  async stopStrategy(userId: number | string, runId: number) {
    const numericUserId = await this.resolveUserId(userId);
    const jobId = `run_${runId}`;
    const job = this.jobs.get(jobId);

    const run = await this.prisma.strategyRun.findFirst({
      where: { id: runId, userId: numericUserId },
    });

    if (!run) {
      throw new BadRequestException('Strategy run not found');
    }

    // Close open positions
    if (job?.exchangeInstance) {
      const openTrades = await this.prisma.trade.findMany({
        where: {
          strategyRunId: runId,
          side: 'buy',
          status: 'filled',
          exitPrice: null,
        },
      });

      for (const trade of openTrades) {
        try {
          const exchange = job.exchangeInstance;
          const preciseQty = String(
            exchange.amountToPrecision(trade.symbol, trade.quantity),
          );
          const order: any = await (exchange as any).createOrder(
            trade.symbol,
            'market',
            'sell',
            preciseQty,
          );
          const exitPrice = order.average || order.price || trade.price;
          const profitLoss = (exitPrice - trade.entryPrice!) * trade.quantity;

          await this.prisma.trade.update({
            where: { id: trade.id },
            data: { exitPrice, profitLoss, comment: 'Closed on stop' },
          });
        } catch (err: any) {
          this.logger.error(`Failed to close ${trade.symbol}: ${err.message}`);
        }
      }
    }

    this.stopJob(jobId);

    await this.prisma.strategyRun.update({
      where: { id: runId },
      data: { status: 'stopped', stoppedAt: new Date() },
    });

    await this.prisma.strategy.update({
      where: { id: run.strategyId },
      data: { isActive: false },
    });

    return { status: 'stopped', runId };
  }

  // Get running strategies
  async getRunningStrategies(userId: number | string) {
    const numericUserId = await this.resolveUserId(userId);

    const runs = await this.prisma.strategyRun.findMany({
      where: { userId: numericUserId, status: 'running' },
      include: {
        strategy: { select: { id: true, name: true, pairs: true } },
        trades: { take: 5, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { startedAt: 'desc' },
    });

    return runs.map((run) => ({
      ...run,
      isLive: this.jobs.has(`run_${run.id}`),
    }));
  }

  // Get run details
  async getRunDetails(userId: number | string, runId: number) {
    const numericUserId = await this.resolveUserId(userId);

    const run = await this.prisma.strategyRun.findFirst({
      where: { id: runId, userId: numericUserId },
      include: {
        strategy: true,
        trades: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!run) return null;

    const job = this.jobs.get(`run_${runId}`);
    return { ...run, isLive: !!job, stats: job?.stats };
  }

  // List all active jobs
  listJobs() {
    return Array.from(this.jobs.entries()).map(([id, job]) => ({
      id,
      runId: job.runId,
      strategyId: job.strategyId,
      userId: job.userId,
      status: job.status,
      stats: job.stats,
    }));
  }
}
