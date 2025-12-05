import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { StartStrategyDto } from './dto/start-strategy.dto';
import { StopStrategyDto } from './dto/stop-strategy.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { Exchange } from 'ccxt';

interface ActiveJob {
  id: string;
  runId: number;
  strategyId: number;
  userId: number;
  exchange: string;
  exchangeInstance: Exchange; // Keep reference to close positions
  symbols: string[];
  config: any;
  orderSize: number; // $ amount per trade
  maxBudget: number; // Max loss before closing all positions
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

interface IndicatorValues {
  rsi?: number;
  prevRsi?: number;
  macdLine?: number;
  macdSignal?: number;
  prevMacdLine?: number;
  prevMacdSignal?: number;
  smaFast?: number;
  smaSlow?: number;
  prevSmaFast?: number;
  prevSmaSlow?: number;
  bbPercent?: number;
  prevBbPercent?: number;
  close: number;
  prevClose?: number;
}

@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);
  private jobs: Map<string, ActiveJob> = new Map();
  private indicatorCache: Map<string, any[]> = new Map();
  // Cache for userId resolution (supabaseId -> numeric userId)
  private userIdCache: Map<string, { id: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly prisma: PrismaService) {
    this.logger.log('StrategiesService initialized');
  }

  // Helper to resolve userId - handles both numeric IDs and supabaseId strings
  private async resolveUserId(userId: number | string): Promise<number> {
    if (typeof userId === 'number') {
      return userId;
    }
    
    // Check cache first
    const cached = this.userIdCache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.id;
    }
    
    // It's a supabaseId string - look up the actual user
    const startTime = Date.now();
    
    try {
      let user = await this.prisma.user.findFirst({
        where: { supabaseId: userId },
        select: { id: true },
      });
      
      const elapsed = Date.now() - startTime;
      if (elapsed > 1000) {
        this.logger.warn(`Slow user resolution: ${elapsed}ms for ${userId}`);
      }
      
      if (!user) {
        // Try to create the user if they don't exist
        this.logger.log(`User not found for supabaseId ${userId}, creating...`);
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
      
      // Cache the result
      this.userIdCache.set(userId, { id: user.id, timestamp: Date.now() });
      
      return user.id;
    } catch (e) {
      this.logger.error(`Failed to resolve userId: ${e.message}`);
      // Return cached value if available (even if expired) as fallback
      if (cached) {
        this.logger.warn(`Using expired cache for ${userId}`);
        return cached.id;
      }
      throw new BadRequestException('Could not resolve user');
    }
  }

  // Calculate RSI
  private calculateRSI(closes: number[], period: number = 14): number | null {
    if (closes.length < period + 1) return null;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgGain / (avgLoss || 1e-9);
    
    return 100 - 100 / (1 + rs);
  }

  // Calculate SMA
  private calculateSMA(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // Calculate EMA
  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) return [];
    
    const ema: number[] = [];
    const multiplier = 2 / (period + 1);
    
    // Start with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    ema.push(sum / period);
    
    for (let i = period; i < values.length; i++) {
      ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    
    return ema;
  }

  // Calculate MACD
  private calculateMACD(closes: number[], fast = 12, slow = 26, signal = 9): { line: number; signal: number } | null {
    if (closes.length < slow + signal) return null;
    
    const emaFast = this.calculateEMA(closes, fast);
    const emaSlow = this.calculateEMA(closes, slow);
    
    if (emaFast.length === 0 || emaSlow.length === 0) return null;
    
    const macdLine: number[] = [];
    const offset = slow - fast;
    
    for (let i = 0; i < emaSlow.length; i++) {
      if (i + offset < emaFast.length) {
        macdLine.push(emaFast[i + offset] - emaSlow[i]);
      }
    }
    
    if (macdLine.length < signal) return null;
    
    const signalLine = this.calculateEMA(macdLine, signal);
    
    return {
      line: macdLine[macdLine.length - 1],
      signal: signalLine[signalLine.length - 1]
    };
  }

  // Calculate Bollinger Bands %B
  private calculateBBPercent(closes: number[], period = 20, deviation = 2): number | null {
    if (closes.length < period) return null;
    
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    
    const upperBand = mean + deviation * stdDev;
    const lowerBand = mean - deviation * stdDev;
    const currentPrice = closes[closes.length - 1];
    
    return (currentPrice - lowerBand) / (upperBand - lowerBand || 1);
  }

  // Check if conditions are met
  private checkConditions(conditions: any[], indicators: IndicatorValues, prevIndicators?: IndicatorValues): boolean {
    if (!conditions || conditions.length === 0) return true;

    for (const cond of conditions) {
      const indicator = cond.indicator;
      const subfields = cond.subfields || {};
      const condition = subfields.Condition || subfields['MACD Trigger'];
      const targetValue = subfields['Signal Value'];

      let currentValue: number | undefined;
      let previousValue: number | undefined;
      let compareValue: number | undefined;
      let prevCompareValue: number | undefined;

      switch (indicator) {
        case 'RSI':
          currentValue = indicators.rsi;
          previousValue = prevIndicators?.rsi;
          break;
        case 'MA':
          currentValue = indicators.smaFast;
          previousValue = prevIndicators?.smaFast;
          compareValue = indicators.smaSlow;
          prevCompareValue = prevIndicators?.smaSlow;
          break;
        case 'MACD':
          currentValue = indicators.macdLine;
          previousValue = prevIndicators?.macdLine;
          compareValue = indicators.macdSignal;
          prevCompareValue = prevIndicators?.macdSignal;
          
          // Check line trigger if specified
          const lineTrigger = subfields['Line Trigger'];
          if (lineTrigger === 'Greater Than 0' && (currentValue ?? 0) <= 0) return false;
          if (lineTrigger === 'Less Than 0' && (currentValue ?? 0) >= 0) return false;
          break;
        case 'BollingerBands':
          currentValue = indicators.bbPercent;
          previousValue = prevIndicators?.bbPercent;
          break;
        default:
          continue;
      }

      if (currentValue === undefined) return false;

      // For MA and MACD, compare fast to slow/signal
      if (indicator === 'MA' || indicator === 'MACD') {
        if (compareValue === undefined) return false;
        
        switch (condition) {
          case 'Less Than':
            if (currentValue >= compareValue) return false;
            break;
          case 'Greater Than':
            if (currentValue <= compareValue) return false;
            break;
          case 'Crossing Up':
            if (!prevCompareValue || !previousValue) return false;
            if (!(previousValue <= prevCompareValue && currentValue > compareValue)) return false;
            break;
          case 'Crossing Down':
            if (!prevCompareValue || !previousValue) return false;
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

  // Get user's saved strategies
  async getUserStrategies(userId: number | string) {
    const numericUserId = await this.resolveUserId(userId);
    return this.prisma.strategy.findMany({
      where: { userId: numericUserId },
      orderBy: { updatedAt: 'desc' },
      include: {
        runs: {
          where: { status: 'running' },
          take: 1
        }
      }
    });
  }

  // Save a new strategy
  async saveStrategy(userId: number | string, data: {
    name: string;
    description?: string;
    category?: string;
    config: any;
    pairs: string[];
    maxDeals?: number;
    orderSize?: number;
    backtestResults?: any;
    isPublic?: boolean;
  }) {
    const numericUserId = await this.resolveUserId(userId);
    this.logger.log(`Saving strategy for user ID: ${numericUserId}`);
    
    const strategy = await this.prisma.strategy.create({
      data: {
        userId: numericUserId,
        name: data.name,
        description: data.description,
        category: data.category || 'Custom',
        config: JSON.stringify(data.config),
        pairs: JSON.stringify(data.pairs),
        maxDeals: data.maxDeals || 5,
        orderSize: data.orderSize || 1000,
        lastBacktestProfit: data.backtestResults?.net_profit,
        lastBacktestDrawdown: data.backtestResults?.max_drawdown,
        lastBacktestSharpe: data.backtestResults?.sharpe_ratio,
        lastBacktestWinRate: data.backtestResults?.win_rate,
        isPublic: data.isPublic ?? true, // Default to public so it appears in strategies list
      }
    });

    return strategy;
  }

  // Update strategy
  async updateStrategy(userId: number | string, strategyId: number, data: any) {
    const numericUserId = await this.resolveUserId(userId);
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId: numericUserId }
    });

    if (!strategy) {
      throw new BadRequestException('Strategy not found');
    }

    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: {
        name: data.name,
        description: data.description,
        config: data.config ? JSON.stringify(data.config) : undefined,
        pairs: data.pairs ? JSON.stringify(data.pairs) : undefined,
        maxDeals: data.maxDeals,
        orderSize: data.orderSize,
      }
    });
  }

  // Delete strategy
  async deleteStrategy(userId: number | string, strategyId: number) {
    const numericUserId = await this.resolveUserId(userId);
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId: numericUserId }
    });

    if (!strategy) {
      throw new BadRequestException('Strategy not found');
    }

    // Stop any running instances
    for (const [jobId, job] of this.jobs) {
      if (job.strategyId === strategyId) {
        this.stopJob(jobId);
      }
    }

    await this.prisma.strategy.delete({
      where: { id: strategyId }
    });

    return { success: true };
  }

  // Start a strategy run
  async startStrategy(
    userId: number | string,
    strategyId: number,
    exchangeInstance: Exchange,
    maxBudget: number, // Max amount user is willing to lose
    orderSizeOverride?: number // Override order size from strategy
  ) {
    const numericUserId = await this.resolveUserId(userId);
    const strategy = await this.prisma.strategy.findFirst({
      where: { id: strategyId, userId: numericUserId }
    });

    if (!strategy) {
      throw new BadRequestException('Strategy not found');
    }

    // Check if already running
    for (const job of this.jobs.values()) {
      if (job.strategyId === strategyId && job.status === 'running') {
        throw new BadRequestException('Strategy is already running');
      }
    }

    const config = JSON.parse(strategy.config);
    const pairs = JSON.parse(strategy.pairs);
    const orderSize = orderSizeOverride || strategy.orderSize || 10; // Default to $10

    // Create strategy run record
    const run = await this.prisma.strategyRun.create({
      data: {
        userId: numericUserId,
        strategyId,
        config: strategy.config,
        pairs: strategy.pairs,
        exchange: 'binance',
        initialBalance: maxBudget,
        currentBalance: maxBudget,
        status: 'running'
      }
    });

    this.logger.log(`Starting strategy ${strategyId}: orderSize=$${orderSize}, maxBudget=$${maxBudget}`);

    // Create job
    const jobId = `run_${run.id}`;
    const job: ActiveJob = {
      id: jobId,
      runId: run.id,
      strategyId,
      userId: numericUserId,
      exchange: 'binance',
      exchangeInstance: exchangeInstance,
      symbols: pairs,
      config,
      orderSize, // Actual $ amount per trade
      maxBudget, // Max loss before closing all
      status: 'running',
      timer: null as any,
      stats: {
        trades: 0,
        wins: 0,
        profit: 0,
        unrealizedPnL: 0,
        lastCheck: new Date()
      }
    };

    // Start the trading loop
    const intervalMs = config.intervalMs || 60000; // Default 1 minute
    job.timer = setInterval(async () => {
      await this.executeTradingTick(job, exchangeInstance);
    }, intervalMs);

    // Execute first tick immediately
    this.executeTradingTick(job, exchangeInstance);

    this.jobs.set(jobId, job);
    
    // Update strategy as active (gracefully handle DB errors)
    try {
      await this.prisma.strategy.update({
        where: { id: strategyId },
        data: { isActive: true }
      });
    } catch (dbError) {
      this.logger.warn(`Could not update strategy active status: ${dbError.message}`);
      // Continue anyway - the job is already running
    }

    this.logger.log(`Started strategy run ${run.id} for strategy ${strategyId}`);

    return {
      success: true,
      runId: run.id,
      jobId,
      message: `Strategy started on ${pairs.length} pairs`
    };
  }

  // Execute one trading tick
  private async executeTradingTick(job: ActiveJob, exchange: Exchange) {
    try {
      // First, check if we've exceeded max budget (unrealized loss)
      let openTrades: any[] = [];
      try {
        openTrades = await this.prisma.trade.findMany({
          where: {
            strategyRunId: job.runId,
            side: 'buy',
            status: 'filled',
            exitPrice: null
          }
        });
      } catch (dbError) {
        this.logger.warn(`[${job.id}] DB error fetching open trades, skipping tick: ${dbError.message}`);
        return; // Skip this tick, try again next time
      }
      
      // Calculate unrealized P&L across all open positions
      let unrealizedPnL = 0;
      for (const trade of openTrades) {
        try {
          const ticker = await exchange.fetchTicker(trade.symbol);
          const currentPrice = ticker.last || ticker.close || trade.price;
          const pnl = (currentPrice - trade.entryPrice!) * trade.quantity;
          unrealizedPnL += pnl;
        } catch {
          // Use entry price if can't fetch current
        }
      }
      
      job.stats.unrealizedPnL = unrealizedPnL;
      
      // Check if total loss (realized + unrealized) exceeds max budget
      const totalLoss = Math.abs(Math.min(0, job.stats.profit + unrealizedPnL));
      if (totalLoss >= job.maxBudget) {
        this.logger.warn(`[${job.id}] MAX BUDGET EXCEEDED! Loss: $${totalLoss.toFixed(2)} >= Budget: $${job.maxBudget}`);
        this.logger.warn(`[${job.id}] EMERGENCY: Closing all ${openTrades.length} positions`);
        
        // Close all positions immediately
        for (const trade of openTrades) {
          try {
            const preciseQty = String(exchange.amountToPrecision(trade.symbol, trade.quantity) || trade.quantity);
            const order: any = await (exchange as any).createOrder(trade.symbol, 'market', 'sell', preciseQty);
            const exitPrice = order.average || order.price || trade.price;
            
            await this.prisma.trade.update({
              where: { id: trade.id },
              data: {
                exitPrice,
                profitLoss: (exitPrice - trade.entryPrice!) * trade.quantity,
                profitPercent: ((exitPrice - trade.entryPrice!) / trade.entryPrice!) * 100,
                comment: 'EMERGENCY CLOSE: Max budget exceeded'
              }
            });
            
            this.logger.log(`[${job.id}] Emergency closed ${trade.symbol}`);
          } catch (e: any) {
            this.logger.error(`[${job.id}] Failed to emergency close ${trade.symbol}: ${e.message}`);
          }
        }
        
        // Stop the strategy
        await this.stopStrategy(job.userId, job.runId);
        return;
      }
      
      const config = job.config;
      const entryConditions = config.entry_conditions || config.bullish_entry_conditions || [];
      const exitConditions = config.exit_conditions || config.bullish_exit_conditions || [];

      for (const symbol of job.symbols) {
        try {
          // Fetch recent OHLCV data
          const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
          const closes = ohlcv.map(c => c[4] as number);
          const currentPrice = closes[closes.length - 1];

          // Calculate indicators
          const indicators: IndicatorValues = {
            close: currentPrice,
            prevClose: closes[closes.length - 2],
            rsi: this.calculateRSI(closes, 14) ?? undefined,
            prevRsi: this.calculateRSI(closes.slice(0, -1), 14) ?? undefined,
            smaFast: this.calculateSMA(closes, 20) ?? undefined,
            smaSlow: this.calculateSMA(closes, 50) ?? undefined,
            prevSmaFast: this.calculateSMA(closes.slice(0, -1), 20) ?? undefined,
            prevSmaSlow: this.calculateSMA(closes.slice(0, -1), 50) ?? undefined,
            bbPercent: this.calculateBBPercent(closes, 20, 2) ?? undefined,
            prevBbPercent: this.calculateBBPercent(closes.slice(0, -1), 20, 2) ?? undefined,
          };

          const macd = this.calculateMACD(closes);
          const prevMacd = this.calculateMACD(closes.slice(0, -1));
          if (macd) {
            indicators.macdLine = macd.line;
            indicators.macdSignal = macd.signal;
          }
          if (prevMacd) {
            indicators.prevMacdLine = prevMacd.line;
            indicators.prevMacdSignal = prevMacd.signal;
          }

          const prevIndicators: IndicatorValues = {
            close: indicators.prevClose!,
            rsi: indicators.prevRsi,
            smaFast: indicators.prevSmaFast,
            smaSlow: indicators.prevSmaSlow,
            macdLine: indicators.prevMacdLine,
            macdSignal: indicators.prevMacdSignal,
            bbPercent: indicators.prevBbPercent,
          };

          // Check for open position
          const openTrade = await this.prisma.trade.findFirst({
            where: {
              strategyRunId: job.runId,
              symbol,
              side: 'buy',
              status: 'filled',
              exitPrice: null
            }
          });

          if (!openTrade) {
            // Check entry conditions
            if (this.checkConditions(entryConditions, indicators, prevIndicators)) {
              // Execute buy - ACTUALLY PLACE ORDER ON EXCHANGE
              // Use job.orderSize (the user's specified $ amount per trade)
              const quantity = job.orderSize / currentPrice;
              const preciseQty = String(exchange.amountToPrecision(symbol, quantity) || quantity);
              
              this.logger.log(`[${job.id}] Order size: $${job.orderSize}, Qty: ${preciseQty} ${symbol}`);
              
              let orderId: string | undefined;
              let actualPrice = currentPrice;
              let actualQty = Number(preciseQty);
              
              try {
                // Place REAL order on exchange
                this.logger.log(`[${job.id}] Placing BUY order: ${preciseQty} ${symbol}`);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
                const order: any = await (exchange as any).createOrder(symbol, 'market', 'buy', preciseQty);
                orderId = order.id;
                actualPrice = order.average || order.price || currentPrice;
                actualQty = order.filled || Number(preciseQty);
                this.logger.log(`[${job.id}] Order filled: ${orderId} @ ${actualPrice}`);
              } catch (orderErr: any) {
                this.logger.error(`[${job.id}] Order failed: ${orderErr.message}`);
                // Still record the attempted trade
              }
              
              const trade = await this.prisma.trade.create({
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
                  comment: orderId ? 'Entry signal - order filled' : 'Entry signal - order failed'
                }
              });

              job.stats.trades++;
              this.logger.log(`[${job.id}] BUY ${symbol} @ ${actualPrice} (Order: ${orderId || 'FAILED'})`);
            }
          } else {
            // Check exit conditions
            if (this.checkConditions(exitConditions, indicators, prevIndicators)) {
              // Execute sell - ACTUALLY PLACE ORDER ON EXCHANGE
              let orderId: string | undefined;
              let actualPrice = currentPrice;
              
              try {
                // Place REAL sell order on exchange
                const preciseQty = String(exchange.amountToPrecision(symbol, openTrade.quantity) || openTrade.quantity);
                this.logger.log(`[${job.id}] Placing SELL order: ${preciseQty} ${symbol}`);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
                const order: any = await (exchange as any).createOrder(symbol, 'market', 'sell', preciseQty);
                orderId = order.id;
                actualPrice = order.average || order.price || currentPrice;
                this.logger.log(`[${job.id}] Sell order filled: ${orderId} @ ${actualPrice}`);
              } catch (orderErr: any) {
                this.logger.error(`[${job.id}] Sell order failed: ${orderErr.message}`);
              }
              
              const profitLoss = (actualPrice - openTrade.entryPrice!) * openTrade.quantity;
              const profitPercent = ((actualPrice - openTrade.entryPrice!) / openTrade.entryPrice!) * 100;

              await this.prisma.trade.update({
                where: { id: openTrade.id },
                data: {
                  exitPrice: actualPrice,
                  profitLoss,
                  profitPercent,
                  orderId: orderId ? `${openTrade.orderId || ''} / ${orderId}` : openTrade.orderId,
                  comment: orderId ? 'Exit signal - order filled' : 'Exit signal - order failed'
                }
              });

              job.stats.trades++;
              job.stats.profit += profitLoss;
              if (profitLoss > 0) job.stats.wins++;

              this.logger.log(`[${job.id}] SELL ${symbol} @ ${actualPrice} (P/L: ${profitLoss.toFixed(2)}, Order: ${orderId || 'FAILED'})`);

              // Update run stats
              await this.prisma.strategyRun.update({
                where: { id: job.runId },
                data: {
                  totalTrades: job.stats.trades,
                  winningTrades: job.stats.wins,
                  totalProfit: job.stats.profit
                }
              });
            }
          }
        } catch (err) {
          this.logger.error(`[${job.id}] Error processing ${symbol}: ${err.message}`);
        }
      }

      job.stats.lastCheck = new Date();
    } catch (err) {
      this.logger.error(`[${job.id}] Tick error: ${err.message}`);
      job.status = 'error';
      
      await this.prisma.strategyRun.update({
        where: { id: job.runId },
        data: {
          lastError: err.message,
          errorCount: { increment: 1 }
        }
      });
    }
  }

  // Stop a running job
  private stopJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (job) {
      clearInterval(job.timer);
      this.jobs.delete(jobId);
    }
  }

  // Stop strategy run - close all open positions first
  async stopStrategy(userId: number | string, runId: number) {
    const numericUserId = await this.resolveUserId(userId);
    const jobId = `run_${runId}`;
    const job = this.jobs.get(jobId);

    if (!job || job.userId !== numericUserId) {
      throw new BadRequestException('Strategy run not found');
    }

    // Close all open positions before stopping
    const closedPositions: string[] = [];
    try {
      const openTrades = await this.prisma.trade.findMany({
        where: {
          strategyRunId: runId,
          side: 'buy',
          status: 'filled',
          exitPrice: null
        }
      });

      for (const trade of openTrades) {
        try {
          const exchange = job.exchangeInstance;
          const preciseQty = String(exchange.amountToPrecision(trade.symbol, trade.quantity) || trade.quantity);
          
          this.logger.log(`[${jobId}] Closing position: SELL ${preciseQty} ${trade.symbol}`);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
          const order: any = await (exchange as any).createOrder(trade.symbol, 'market', 'sell', preciseQty);
          
          const exitPrice = order.average || order.price || trade.price;
          const profitLoss = (exitPrice - trade.entryPrice!) * trade.quantity;
          const profitPercent = ((exitPrice - trade.entryPrice!) / trade.entryPrice!) * 100;
          
          await this.prisma.trade.update({
            where: { id: trade.id },
            data: {
              exitPrice,
              profitLoss,
              profitPercent,
              orderId: `${trade.orderId || ''} / ${order.id}`,
              comment: 'Position closed on strategy stop'
            }
          });
          
          closedPositions.push(`${trade.symbol} @ ${exitPrice}`);
          this.logger.log(`[${jobId}] Closed ${trade.symbol} @ ${exitPrice} (P/L: ${profitLoss.toFixed(2)})`);
        } catch (err) {
          this.logger.error(`[${jobId}] Failed to close ${trade.symbol}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[${jobId}] Error closing positions: ${err.message}`);
    }

    this.stopJob(jobId);

    // Update database
    await this.prisma.strategyRun.update({
      where: { id: runId },
      data: {
        status: 'stopped',
        stoppedAt: new Date()
      }
    });

    await this.prisma.strategy.update({
      where: { id: job.strategyId },
      data: { isActive: false }
    });

    return { 
      success: true, 
      message: `Strategy stopped. Closed ${closedPositions.length} open position(s).`,
      closedPositions
    };
  }

  // Get running strategies for user
  async getRunningStrategies(userId: number | string) {
    const numericUserId = await this.resolveUserId(userId);
    const runs = await this.prisma.strategyRun.findMany({
      where: { userId: numericUserId, status: 'running' },
      include: {
        strategy: true,
        trades: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    return runs.map(run => {
      const jobId = `run_${run.id}`;
      const job = this.jobs.get(jobId);
      
      return {
        ...run,
        pairs: JSON.parse(run.pairs),
        isLive: !!job,
        lastCheck: job?.stats.lastCheck
      };
    });
  }

  // Get strategy run details with trades
  async getRunDetails(userId: number | string, runId: number) {
    const numericUserId = await this.resolveUserId(userId);
    const run = await this.prisma.strategyRun.findFirst({
      where: { id: runId, userId: numericUserId },
      include: {
        strategy: true,
        trades: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!run) {
      throw new BadRequestException('Run not found');
    }

    const jobId = `run_${run.id}`;
    const job = this.jobs.get(jobId);

    return {
      ...run,
      config: JSON.parse(run.config),
      pairs: JSON.parse(run.pairs),
      isLive: !!job,
      liveStats: job?.stats
    };
  }

  // List all jobs (for monitoring)
  listJobs() {
    return Array.from(this.jobs.values()).map(job => ({
      id: job.id,
      runId: job.runId,
      strategyId: job.strategyId,
      status: job.status,
      symbols: job.symbols,
      stats: job.stats
    }));
  }
}
