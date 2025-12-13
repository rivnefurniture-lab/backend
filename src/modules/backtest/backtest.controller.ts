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
        // Equity curve - 2023-2025 only
        history: [
          { year: '2023', value: 5075 },
          { year: '2023', value: 5079 },
          { year: '2023', value: 5907 },
          { year: '2023', value: 5943 },
          { year: '2023', value: 6117 },
          { year: '2023', value: 6136 },
          { year: '2023', value: 5713 },
          { year: '2023', value: 5787 },
          { year: '2023', value: 5855 },
          { year: '2024', value: 6026 },
          { year: '2024', value: 6061 },
          { year: '2024', value: 7018 },
          { year: '2024', value: 7144 },
          { year: '2024', value: 7302 },
          { year: '2024', value: 8359 },
          { year: '2024', value: 9556 },
          { year: '2024', value: 9724 },
          { year: '2024', value: 9720 },
          { year: '2025', value: 10314 },
          { year: '2025', value: 10070 },
          { year: '2025', value: 13212 },
          { year: '2025', value: 15126 },
          { year: '2025', value: 15056 },
          { year: '2025', value: 15152 },
          { year: '2025', value: 15257 },
          { year: '2025', value: 15321 },
          { year: '2025', value: 15893 },
          { year: '2025', value: 14571 },
          { year: '2025', value: 15868 },
        ],
        // Sample of actual trades from the backtest
        trades: [
          {
            date: '2023-01-06',
            symbol: 'TRX/USDT',
            action: 'BUY',
            price: 0.0505,
            exitPrice: 0.0544,
            profitPercent: 7.5,
            profitUsd: 75.38,
            duration: '2 days',
          },
          {
            date: '2023-02-09',
            symbol: 'SOL/USDT',
            action: 'BUY',
            price: 20.36,
            exitPrice: 20.48,
            profitPercent: 0.4,
            profitUsd: 3.95,
            duration: '1 day',
          },
          {
            date: '2023-03-03',
            symbol: 'LTC/USDT',
            action: 'BUY',
            price: 87.73,
            exitPrice: 90.56,
            profitPercent: 3.0,
            profitUsd: 30.69,
            duration: '1 day',
          },
          {
            date: '2023-03-09',
            symbol: 'BTC/USDT',
            action: 'BUY',
            price: 20847.28,
            exitPrice: 24113.48,
            profitPercent: 15.7,
            profitUsd: 157.82,
            duration: '4 days',
          },
          {
            date: '2023-03-09',
            symbol: 'ETH/USDT',
            action: 'BUY',
            price: 1425.82,
            exitPrice: 1580.33,
            profitPercent: 10.8,
            profitUsd: 108.53,
            duration: '3 days',
          },
        ],
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

        dbBacktests = recentBacktests.map((b) => ({
          id: `backtest-${b.id}`,
          name: b.name,
          description: `Backtested from ${b.startDate.toISOString().split('T')[0]} to ${b.endDate.toISOString().split('T')[0]}`,
          category: 'User Strategy',
          cagr: b.yearlyReturn || 0,
          sharpe: b.sharpeRatio || 0,
          sortino: b.sortinoRatio || 0,
          winRate: b.winRate || 0,
          maxDD: b.maxDrawdown || 0,
          totalTrades: b.totalTrades || 0,
          profitFactor: b.profitFactor || 0,
          netProfitUsd: b.netProfitUsd || 0,
          returns: {
            daily: ((b.yearlyReturn || 0) / 365).toFixed(3),
            weekly: ((b.yearlyReturn || 0) / 52).toFixed(2),
            monthly: ((b.yearlyReturn || 0) / 12).toFixed(1),
            yearly: b.yearlyReturn || 0,
          },
          pairs: b.pairs ? JSON.parse(b.pairs as string) : [],
          tags: b.pairs
            ? JSON.parse(b.pairs as string).slice(0, 3)
            : ['Crypto'],
          updatedAt: b.updatedAt,
          history: b.chartData
            ? JSON.parse(b.chartData as string).monthlyGrowth?.map((m: any) => ({
                year: m.month.split('-')[0],
                value: m.balance,
              }))
            : [],
        }));
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
    const userId = await this.getUserId(req);
    return this.backtestService.getBacktestResults(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('results/:id')
  async getResult(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const userId = await this.getUserId(req);
    return this.backtestService.getBacktestResult(parseInt(id), userId);
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

    return {
      queued,
      processing,
      completed,
      totalInQueue: queued + processing,
      estimatedWaitMinutes: queued * 15,
    };
  }

  // Admin endpoint - get all queue items
  @UseGuards(JwtAuthGuard)
  @Get('queue/all')
  async getAllQueueItems() {
    return await this.prisma.backtestQueue.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
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
