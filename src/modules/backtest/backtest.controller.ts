import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from './queue.service';

interface JwtUser {
  sub: string; // Supabase UUID
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('backtest')
export class BacktestController {
  // Cache for userId resolution
  private userIdCache: Map<string, { id: number; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly backtestService: BacktestService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  // Resolve Supabase UUID to database user ID (with caching)
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = req.user?.sub || '';
    const email = req.user?.email || '';

    // Check cache first
    const cached = this.userIdCache.get(supabaseId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.id;
    }

    try {
      let user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: { id: true },
      });

      if (!user && email) {
        user = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
      }

      const userId = user?.id || 1;

      // Cache the result
      if (supabaseId && userId !== 1) {
        this.userIdCache.set(supabaseId, { id: userId, timestamp: Date.now() });
      }

      return userId;
    } catch (e) {
      // Return cached value if available as fallback
      if (cached) {
        return cached.id;
      }
      return 1;
    }
  }

  @Get('indicators')
  getIndicators() {
    return this.backtestService.getAvailableIndicators();
  }

  @Get('templates')
  getTemplates() {
    return this.backtestService.getStrategyTemplates();
  }

  @Get('strategies')
  async getAllStrategies() {
    try {
      // Real backtest data from 2023-2025 with actual trades and yearly breakdown
      const realBacktest = {
        id: 'real-rsi-ma-bb-2023-2025',
        name: 'RSI & Moving Average with Bollinger Bands Exit',
        description:
          'Conservative strategy entering on RSI oversold with EMA confirmation, exiting on Bollinger Bands signals. Tested on 17 pairs over 3 years.',
        category: 'Trend Following',
        cagr: 53,
        sharpe: 1.13,
        sortino: 1.22,
        winRate: 78,
        maxDD: 20,
        totalTrades: 101,
        profitFactor: 7.8,
        netProfitUsd: 12261.76,
        avgDealDuration: '9 days, 7 hours',
        returns: {
          daily: 0.15,
          weekly: 1.02,
          monthly: 4.42,
          yearly: 53,
        },
        yearlyBreakdown: {
          '2023': { return: 17.1, balance: 5855.59, trades: 10, winRate: 90 },
          '2024': { return: 65.9, balance: 9720.28, trades: 39, winRate: 79 },
          '2025': { return: 63.3, balance: 15868.02, trades: 52, winRate: 75 },
        },
        pairs: [
          'BTC/USDT',
          'ETH/USDT',
          'ADA/USDT',
          'SOL/USDT',
          'AVAX/USDT',
          'DOT/USDT',
          'LINK/USDT',
          'ATOM/USDT',
          'NEAR/USDT',
          'LTC/USDT',
          'XRP/USDT',
          'DOGE/USDT',
          'TRX/USDT',
          'HBAR/USDT',
          'SUI/USDT',
          'BCH/USDT',
          'RENDER/USDT',
        ],
        tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
        updatedAt: new Date('2025-12-10'),
        isPreset: true,
        // Equity curve - monthly snapshots 2023-2025
        history: [
          { year: 'Jan 23', value: 5000 },
          { year: 'Apr 23', value: 5075 },
          { year: 'Jul 23', value: 5500 },
          { year: 'Oct 23', value: 5855 },
          { year: 'Jan 24', value: 6026 },
          { year: 'Apr 24', value: 7018 },
          { year: 'Jul 24', value: 8359 },
          { year: 'Oct 24', value: 9720 },
          { year: 'Jan 25', value: 10314 },
          { year: 'Apr 25', value: 13212 },
          { year: 'Jul 25', value: 15126 },
          { year: 'Oct 25', value: 15868 },
        ],
        // Trading conditions configuration
        config: {
          entry_conditions: [
            {
              indicator: 'RSI',
              subfields: {
                Timeframe: '1h',
                'RSI Length': 21,
                'Signal Value': 20,
                Condition: 'Less Than',
              },
            },
            {
              indicator: 'MA',
              subfields: {
                Timeframe: '1h',
                'MA Type': 'EMA',
                'Fast MA': 20,
                'Slow MA': 100,
                Condition: 'Less Than',
              },
            },
          ],
          exit_conditions: [
            {
              indicator: 'BollingerBands',
              subfields: {
                Timeframe: '1d',
                'BB% Period': 50,
                Deviation: 1,
                Condition: 'Greater Than',
                'Signal Value': 0.1,
              },
            },
          ],
        },
        // Sample trades from actual backtest (formatted for frontend)
        recentTrades: [
          {
            date: '2023-01-06',
            time: '04:59:00',
            pair: 'TRX/USDT',
            side: 'BUY',
            entry: 0.0505,
            orderSize: 1000,
            pnl: 0.075, // 7.5%
            pnlUsd: 75.38,
            balance: 5075.38,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-01-08',
            time: '23:59:00',
            pair: 'TRX/USDT',
            side: 'SELL',
            entry: 0.0544,
            orderSize: 1077.46,
            pnl: 0.075,
            pnlUsd: 75.38,
            balance: 5075.38,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-02-09',
            time: '22:59:00',
            pair: 'SOL/USDT',
            side: 'BUY',
            entry: 20.36,
            orderSize: 1014.86,
            pnl: 0.004,
            pnlUsd: 3.95,
            balance: 5079.32,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-03',
            time: '01:59:00',
            pair: 'LTC/USDT',
            side: 'BUY',
            entry: 87.73,
            orderSize: 1015.45,
            pnl: 0.03,
            pnlUsd: 30.69,
            balance: 5110.02,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-03',
            time: '23:59:00',
            pair: 'LTC/USDT',
            side: 'SELL',
            entry: 90.56,
            orderSize: 1048.2,
            pnl: 0.03,
            pnlUsd: 30.69,
            balance: 5110.02,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-03-09',
            time: '19:59:00',
            pair: 'BTC/USDT',
            side: 'BUY',
            entry: 20847.28,
            orderSize: 1021.37,
            pnl: 0.157,
            pnlUsd: 157.82,
            balance: 5504.56,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-13',
            time: '23:59:00',
            pair: 'BTC/USDT',
            side: 'SELL',
            entry: 24113.48,
            orderSize: 1181.4,
            pnl: 0.157,
            pnlUsd: 157.82,
            balance: 5504.56,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-03-09',
            time: '20:59:00',
            pair: 'ETH/USDT',
            side: 'BUY',
            entry: 1425.82,
            orderSize: 1021.37,
            pnl: 0.108,
            pnlUsd: 108.53,
            balance: 5218.55,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-12',
            time: '23:59:00',
            pair: 'ETH/USDT',
            side: 'SELL',
            entry: 1580.33,
            orderSize: 1132.06,
            pnl: 0.108,
            pnlUsd: 108.53,
            balance: 5218.55,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
        ],
        totalBacktestTrades: 206, // Total from CSV (206 BUY/SELL entries)
      };

      let userStrategies: any[] = [];
      try {
        const dbStrategies = await this.prisma.strategy.findMany({
          where: { isPublic: true },
          orderBy: [{ lastBacktestProfit: 'desc' }, { updatedAt: 'desc' }],
          include: { user: { select: { name: true } } },
        });

        userStrategies = dbStrategies.map((s) => ({
          id: `db-${s.id}`,
          name: s.name,
          description: s.description,
          category: s.category || 'Custom',
          config: s.config ? JSON.parse(s.config) : {},
          pairs: s.pairs ? JSON.parse(s.pairs) : [],
          cagr: s.lastBacktestProfit || 0,
          sharpe: s.lastBacktestSharpe || 0,
          maxDD: s.lastBacktestDrawdown || 0,
          winRate: s.lastBacktestWinRate || 0,
          returns: {
            daily: ((s.lastBacktestProfit || 0) / 365).toFixed(3),
            weekly: ((s.lastBacktestProfit || 0) / 52).toFixed(2),
            monthly: ((s.lastBacktestProfit || 0) / 12).toFixed(1),
            yearly: s.lastBacktestProfit || 0,
          },
          isRealData: true,
          isUserStrategy: true,
          updatedAt: s.updatedAt.toISOString(),
          createdBy: s.user?.name || 'User',
        }));
      } catch (dbError) {
        console.error('Failed to load user strategies:', dbError.message);
      }

      // Fetch completed backtests from database to show alongside real strategy
      let dbBacktests: any[] = [];
      try {
        const recentBacktests = await this.prisma.backtestResult.findMany({
          where: {
            netProfitUsd: { gt: 0 }, // Only profitable strategies
            totalTrades: { gt: 10 }, // Minimum 10 trades
          },
          orderBy: { sharpeRatio: 'desc' },
          take: 5,
          include: { user: { select: { name: true } } },
        });

        dbBacktests = recentBacktests.map((b) => {
          // Convert raw decimals to percentages (* 100)
          const yearlyReturnPct = (b.yearlyReturn || 0) * 100;
          const winRatePct = (b.winRate || 0) * 100;
          const maxDDPct = (b.maxDrawdown || 0) * 100;

          return {
            id: `backtest-${b.id}`,
            name: b.name,
            description: `Backtested from ${b.startDate.toISOString().split('T')[0]} to ${b.endDate.toISOString().split('T')[0]}`,
            category: 'User Strategy',
            cagr: yearlyReturnPct,
            sharpe: b.sharpeRatio || 0,
            sortino: b.sortinoRatio || 0,
            winRate: winRatePct,
            maxDD: maxDDPct,
            totalTrades: b.totalTrades || 0,
            profitFactor: b.profitFactor || 0,
            netProfitUsd: b.netProfitUsd || 0,
            returns: {
              daily: (yearlyReturnPct / 365).toFixed(3),
              weekly: (yearlyReturnPct / 52).toFixed(2),
              monthly: (yearlyReturnPct / 12).toFixed(1),
              yearly: yearlyReturnPct.toFixed(1),
            },
            pairs: b.pairs ? JSON.parse(b.pairs as string) : [],
            tags: b.pairs
              ? JSON.parse(b.pairs as string).slice(0, 3)
              : ['Crypto'],
            updatedAt: b.createdAt,
            history: b.chartData
              ? JSON.parse(b.chartData as string).monthlyGrowth?.map((m: any) => ({
                  year: m.month.split('-')[0],
                  value: m.balance,
                }))
              : [],
          };
        });
      } catch (e) {
        console.log('Could not fetch database backtests');
      }

      // Return real backtest first, then database backtests, then user strategies
      return [realBacktest, ...dbBacktests, ...userStrategies];
    } catch (error) {
      console.error('Failed to load strategies:', error.message);
      // Fallback to just the real backtest if everything fails
      return [];
    }
  }

  @Get('preset-strategies')
  async getPresetStrategies() {
    return this.backtestService.getPresetStrategiesWithMetrics();
  }

  @Get('preset-strategies/:id/calculate')
  async calculatePresetStrategy(@Param('id') id: string) {
    return this.backtestService.calculatePresetStrategyMetrics(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('run')
  async runBacktest(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RunBacktestDto,
  ) {
    const result = await this.backtestService.runBacktest(dto);

    if (result.status === 'success') {
      const userId = await this.getUserId(req);
      const saved = await this.backtestService.saveBacktestResult(
        userId,
        dto,
        result,
      );
      return { ...result, savedId: saved.id };
    }

    return result;
  }

  @Post('demo')
  async runDemoBacktest(@Body() dto: RunBacktestDto) {
    return this.backtestService.runBacktest(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('results')
  async getResults(@Req() req: AuthenticatedRequest) {
    try {
      const userId = await this.getUserId(req);
      console.log(`[getResults] Fetching results for userId: ${userId}`);
      const results = await this.backtestService.getBacktestResults(userId);
      console.log(`[getResults] Found ${results.length} results`);
      return results;
    } catch (error) {
      console.error('[getResults] Error:', error);
      throw error;
    }
  }

  @Get('results/:id')
  async getResult(@Param('id') id: string) {
    // Allow viewing any backtest result (no auth required for viewing)
    return this.backtestService.getBacktestResult(parseInt(id));
  }

  @Get('results/:id/export/csv')
  async exportCSV(@Param('id') id: string, @Res() res: Response) {
    const result = await this.backtestService.getBacktestResult(parseInt(id));

    if (!result || !result.trades) {
      return res.status(404).json({ error: 'Backtest result not found' });
    }

    const headers = [
      'Date',
      'Time',
      'Symbol',
      'Action',
      'Price',
      'P&L %',
      'P&L $',
      'Equity',
      'Reason',
      'Indicators',
    ];
    const rows = result.trades.map((t: any) =>
      [
        t.date,
        t.time,
        t.symbol,
        t.action,
        t.price,
        t.profit_percent || '0',
        t.profit_usd || '0',
        t.equity,
        `"${t.reason || ''}"`,
        `"${(t.indicatorProof || []).map((p: any) => `${p.indicator}: ${p.value}`).join('; ')}"`,
      ].join(','),
    );

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=backtest_${id}.csv`,
    );
    return res.send(csv);
  }

  @UseGuards(JwtAuthGuard)
  @Post('results/:id/save-as-strategy')
  async saveAsStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { name: string; description?: string },
  ) {
    const userId = await this.getUserId(req);
    return this.backtestService.saveAsStrategy(
      userId,
      parseInt(id),
      body.name,
      body.description,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('results/:id')
  async deleteResult(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const userId = await this.getUserId(req);
    return this.backtestService.deleteBacktestResult(parseInt(id), userId);
  }

  // Get trades for a preset strategy
  @Get('preset-strategies/:id/trades')
  getStrategyTrades(@Param('id') id: string) {
    return this.backtestService.getStrategyTrades(id);
  }

  // Get full strategy details with trades and metrics
  @Get('preset-strategies/:id/details')
  getStrategyDetails(@Param('id') id: string) {
    return this.backtestService.getStrategyDetails(id);
  }

  // Rerun backtest for a strategy with custom configuration
  @Post('preset-strategies/:id/rerun')
  async rerunStrategyBacktest(
    @Param('id') id: string,
    @Body()
    body: {
      startDate?: string;
      endDate?: string;
      initialCapital?: number;
      pairs?: string[];
      config?: Record<string, any>;
    },
  ) {
    return this.backtestService.rerunBacktestWithConfig(id, body);
  }

  // Get available configuration options for a strategy
  @Get('preset-strategies/:id/config-options')
  getStrategyConfigOptions(@Param('id') id: string) {
    return this.backtestService.getStrategyConfigOptions(id);
  }

  // Data status and management
  @Get('data/status')
  getDataStatus() {
    return this.backtestService.getDataStatus();
  }

  @Post('data/update')
  triggerDataUpdate() {
    return this.backtestService.triggerDataUpdate();
  }

  // ============ QUEUE ENDPOINTS ============

  @UseGuards(JwtAuthGuard)
  @Post('queue')
  async addToQueue(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { payload: RunBacktestDto; notifyVia: 'telegram' | 'email' | 'both' },
  ) {
    const userId = await this.getUserId(req);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, telegramId: true },
    });

    if (!user) {
      return { error: 'User not found' };
    }

    const result = await this.queueService.addToQueue(
      userId,
      body.payload.strategy_name || 'My Strategy',
      body.payload,
      body.notifyVia,
      user.email,
      user.telegramId || undefined,
    );

    return {
      success: true,
      message: 'Backtest added to queue',
      ...result,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/position/:queueId')
  async getQueuePosition(@Param('queueId') queueId: string) {
    const position = await this.queueService.getQueuePosition(
      parseInt(queueId),
    );
    return position || { error: 'Queue item not found' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/my')
  async getMyQueue(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.queueService.getUserQueueItems(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('queue/:id/cancel')
  async cancelBacktest(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const queueItem = await this.prisma.backtestQueue.findFirst({
      where: { id: parseInt(id), userId },
    });

    if (!queueItem) {
      return { error: 'Backtest not found or access denied' };
    }

    if (queueItem.status === 'completed') {
      return { error: 'Cannot cancel completed backtest' };
    }

    await this.prisma.backtestQueue.update({
      where: { id: parseInt(id) },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    return { success: true, message: 'Backtest cancelled' };
  }

  // Admin endpoint to delete queue items
  @UseGuards(JwtAuthGuard)
  @Delete('queue/:id')
  async deleteQueueItem(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const queueItem = await this.prisma.backtestQueue.findUnique({
      where: { id: parseInt(id) },
    });

    if (!queueItem) {
      return { error: 'Queue item not found' };
    }

    // Allow deletion of own items OR if status is failed/cancelled/completed
    const canDelete = queueItem.userId === userId || 
                      ['failed', 'cancelled', 'completed'].includes(queueItem.status);

    if (!canDelete) {
      return { error: 'Cannot delete this queue item - must be completed, failed, or cancelled' };
    }

    await this.prisma.backtestQueue.delete({
      where: { id: parseInt(id) },
    });

    return { success: true, message: 'Queue item deleted' };
  }

  // Admin endpoint to force-fail stuck backtests
  @UseGuards(JwtAuthGuard)
  @Post('queue/:id/force-fail')
  async forceFailBacktest(@Param('id') id: string) {
    const queueItem = await this.prisma.backtestQueue.findUnique({
      where: { id: parseInt(id) },
    });

    if (!queueItem) {
      return { error: 'Queue item not found' };
    }

    if (!['queued', 'processing'].includes(queueItem.status)) {
      return { error: 'Can only force-fail queued or processing backtests' };
    }

    await this.prisma.backtestQueue.update({
      where: { id: parseInt(id) },
      data: { 
        status: 'failed', 
        completedAt: new Date(),
        errorMessage: 'Manually terminated by admin (stuck backtest)'
      },
    });

    return { success: true, message: 'Backtest marked as failed' };
  }

  // Endpoint to reset stuck backtests (processing for more than 2 hours)
  @UseGuards(JwtAuthGuard)
  @Post('queue/reset-stuck')
  async resetStuckBacktests() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    const stuck = await this.prisma.backtestQueue.updateMany({
      where: {
        status: 'processing',
        startedAt: { lt: twoHoursAgo },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Auto-terminated: Processing exceeded 2 hour timeout',
      },
    });

    return { 
      success: true, 
      message: `Reset ${stuck.count} stuck backtests`,
      count: stuck.count 
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('limits')
  async getBacktestLimits(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionPlan: true },
    });

    const plan = user?.subscriptionPlan || 'free';
    
    // Define limits per plan
    const limits = {
      free: { monthly: 5, concurrent: 1 },
      starter: { monthly: 20, concurrent: 2 },
      pro: { monthly: 100, concurrent: 5 },
      enterprise: { monthly: -1, concurrent: 10 }, // -1 = unlimited
    };

    const planLimits = limits[plan] || limits.free;

    // Count backtests this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usedThisMonth = await this.prisma.backtestQueue.count({
      where: {
        userId,
        createdAt: { gte: startOfMonth },
        status: { not: 'cancelled' },
      },
    });

    const currentlyRunning = await this.prisma.backtestQueue.count({
      where: {
        userId,
        status: { in: ['queued', 'processing'] },
      },
    });

    return {
      plan,
      limits: planLimits,
      used: {
        monthly: usedThisMonth,
        concurrent: currentlyRunning,
      },
      remaining: {
        monthly: planLimits.monthly === -1 ? -1 : planLimits.monthly - usedThisMonth,
        concurrent: planLimits.concurrent - currentlyRunning,
      },
      canRunBacktest: (planLimits.monthly === -1 || usedThisMonth < planLimits.monthly) && 
                      currentlyRunning < planLimits.concurrent,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/stats')
  async getQueueStats() {
    const queued = await this.prisma.backtestQueue.count({
      where: { status: 'queued' },
    });
    const processing = await this.prisma.backtestQueue.count({
      where: { status: 'processing' },
    });
    const completed = await this.prisma.backtestQueue.count({
      where: { status: 'completed' },
    });

    // Calculate total estimated wait time
    const queuedItems = await this.prisma.backtestQueue.findMany({
      where: { status: { in: ['queued', 'processing'] } },
      select: { payload: true, startedAt: true, status: true },
    });

    let totalWaitSeconds = 0;
    for (const item of queuedItems) {
      const estimated = this.queueService.estimateBacktestTime(JSON.parse(item.payload));
      if (item.status === 'processing' && item.startedAt) {
        const elapsed = (Date.now() - item.startedAt.getTime()) / 1000;
        totalWaitSeconds += Math.max(0, estimated - elapsed);
      } else {
        totalWaitSeconds += estimated;
      }
    }

    return {
      queued,
      processing,
      completed,
      totalInQueue: queued + processing,
      estimatedWaitSeconds: Math.ceil(totalWaitSeconds),
      estimatedWaitMinutes: Math.ceil(totalWaitSeconds / 60),
    };
  }

  // Admin endpoint - get all queue items with time estimates
  @UseGuards(JwtAuthGuard)
  @Get('queue/all')
  async getAllQueueItems() {
    const items = await this.prisma.backtestQueue.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: { user: { select: { email: true, name: true } } },
    });

    // Add time estimates to each item
    const itemsWithEstimates = await Promise.all(
      items.map(async (item) => {
        const estimate = await this.queueService.getEstimatedCompletionTime(item.id);
        return {
          ...item,
          estimatedSeconds: estimate?.estimatedSeconds || 0,
          estimatedCompletion: estimate?.estimatedCompletion || null,
          progress: estimate?.progress || 0,
        };
      })
    );

    return itemsWithEstimates;
  }

  // Get detailed status for user's active backtest (for floating monitor)
  // OPTIMIZED: Uses only 1 DB query to prevent connection pool exhaustion
  @UseGuards(JwtAuthGuard)
  @Get('queue/my-active')
  async getMyActiveBacktests(@Req() req: AuthenticatedRequest) {
    try {
      // Get supabaseId directly from token - avoid extra DB call
      const supabaseId = req.user?.sub;
      if (!supabaseId) {
        return [];
      }

      // Single query: get user and their active backtests in one go
      const user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: {
          id: true,
          backtestQueue: {
            where: { status: { in: ['queued', 'processing'] } },
            orderBy: { createdAt: 'desc' },
            take: 5, // Limit to 5 active backtests
          },
        },
      });

      if (!user || !user.backtestQueue?.length) {
        return [];
      }

      // Calculate progress/estimates in memory without additional DB calls
      return user.backtestQueue.map((item, index) => {
        let progress = 0;
        let estimatedSeconds = 60; // Default estimate

        if (item.status === 'processing' && item.startedAt) {
          const elapsed = (Date.now() - item.startedAt.getTime()) / 1000;
          progress = Math.min(95, elapsed / 60 * 100); // Assume ~60s per backtest
          estimatedSeconds = Math.max(0, 60 - elapsed);
        }

        return {
          id: item.id,
          strategyName: item.strategyName,
          status: item.status,
          queuePosition: index + 1,
          progress,
          estimatedSeconds,
          estimatedCompletion: new Date(Date.now() + estimatedSeconds * 1000).toISOString(),
          startedAt: item.startedAt,
          createdAt: item.createdAt,
        };
      });
    } catch (e) {
      // Silent fail - return empty array
      return [];
    }
  }

  // Admin analytics endpoint
  @UseGuards(JwtAuthGuard)
  @Get('admin/analytics')
  async getAdminAnalytics() {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // User statistics
      const totalUsers = await this.prisma.user.count();
      const usersBySubscription = await this.prisma.user.groupBy({
        by: ['subscriptionPlan'],
        _count: true,
      });

      const subscriptionStats = {
        free:
          usersBySubscription.find((u) => u.subscriptionPlan === 'free')
            ?._count || 0,
        starter:
          usersBySubscription.find((u) => u.subscriptionPlan === 'starter')
            ?._count || 0,
        pro:
          usersBySubscription.find((u) => u.subscriptionPlan === 'pro')
            ?._count || 0,
        enterprise:
          usersBySubscription.find((u) => u.subscriptionPlan === 'enterprise')
            ?._count || 0,
      };

      // Strategy statistics
      const totalStrategies = await this.prisma.strategy.count();
      const activeStrategies = await this.prisma.strategy.count({
        where: { isActive: true },
      });
      const publicStrategies = await this.prisma.strategy.count({
        where: { isPublic: true },
      });

      // Backtest statistics
      const totalBacktests = await this.prisma.backtestResult.count();
      const backtestsLast24h = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: oneDayAgo } },
      });
      const backtestsLast7d = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      });
      const backtestsLast30d = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: thirtyDaysAgo } },
      });

      // Queue statistics
      const queueStats = await this.getQueueStats();

      // Recent signups
      const recentSignups = await this.prisma.user.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      });

      // Average backtest metrics
      const avgMetrics = await this.prisma.backtestResult.aggregate({
        _avg: {
          sharpeRatio: true,
          winRate: true,
          yearlyReturn: true,
        },
      });

      // System health
      const systemHealth = {
        database: 'healthy',
        api: 'healthy',
        worker: 'unknown', // Will be updated by worker status check
        uptime: Math.floor(process.uptime()),
      };

      return {
        users: {
          total: totalUsers,
          bySubscription: subscriptionStats,
          recentSignups,
        },
        strategies: {
          total: totalStrategies,
          active: activeStrategies,
          public: publicStrategies,
        },
        backtests: {
          total: totalBacktests,
          last24h: backtestsLast24h,
          last7d: backtestsLast7d,
          last30d: backtestsLast30d,
          avgSharpe: avgMetrics._avg.sharpeRatio || 0,
          avgWinRate: avgMetrics._avg.winRate || 0,
          avgYearlyReturn: avgMetrics._avg.yearlyReturn || 0,
        },
        queue: queueStats,
        system: systemHealth,
      };
    } catch (error) {
      console.error('Failed to fetch admin analytics:', error);
      return {
        users: {
          total: 0,
          bySubscription: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          recentSignups: 0,
        },
        strategies: { total: 0, active: 0, public: 0 },
        backtests: {
          total: 0,
          last24h: 0,
          last7d: 0,
          last30d: 0,
          avgSharpe: 0,
          avgWinRate: 0,
          avgYearlyReturn: 0,
        },
        queue: {
          queued: 0,
          processing: 0,
          completed: 0,
          totalInQueue: 0,
          estimatedWaitMinutes: 0,
        },
        system: {
          database: 'unknown',
          api: 'unknown',
          worker: 'unknown',
          uptime: 0,
        },
      };
    }
  }

  // Get all trades for a strategy
  @Get('strategies/:id/all-trades')
  async getAllStrategyTrades(@Param('id') id: string) {
    // For the real strategy, load from JSON file
    if (id === 'real-rsi-ma-bb-2023-2025') {
      try {
        const fs = require('fs');
        const path = require('path');
        const tradesPath = path.join(process.cwd(), 'data', 'real_strategy_trades.json');
        const tradesData = fs.readFileSync(tradesPath, 'utf-8');
        const allTrades = JSON.parse(tradesData);
        return {
          strategyId: id,
          total: allTrades.length,
          trades: allTrades,
        };
      } catch (e) {
        return {
          strategyId: id,
          total: 0,
          trades: [],
          error: 'Trades file not found',
        };
      }
    }
    
    // For other strategies, return empty for now
    return {
      strategyId: id,
      total: 0,
      trades: [],
    };
  }

  // Admin recent activity endpoint
  @UseGuards(JwtAuthGuard)
  @Get('admin/recent-activity')
  async getRecentActivity() {
    try {
      // Recent backtests
      const recentBacktests = await this.prisma.backtestResult.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // Recent queue items
      const recentQueueItems = await this.prisma.backtestQueue.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // Recent user signups
      const recentUsers = await this.prisma.user.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          subscriptionPlan: true,
          createdAt: true,
        },
      });

      return {
        backtests: recentBacktests.map((b) => ({
          id: b.id,
          name: b.name,
          user: b.user?.name || 'Unknown',
          netProfit: b.netProfitUsd,
          sharpe: b.sharpeRatio,
          winRate: b.winRate,
          createdAt: b.createdAt,
        })),
        queueItems: recentQueueItems.map((q) => ({
          id: q.id,
          strategyName: q.strategyName,
          user: q.user?.name || 'Unknown',
          status: q.status,
          createdAt: q.createdAt,
          completedAt: q.completedAt,
        })),
        users: recentUsers,
      };
    } catch (error) {
      console.error('Failed to fetch recent activity:', error);
      return {
        backtests: [],
        queueItems: [],
        users: [],
      };
    }
  }
}
