import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req, Res } from '@nestjs/common';
import type { Response, Request } from 'express';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

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
  private userIdCache: Map<string, { id: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly backtestService: BacktestService,
    private readonly prisma: PrismaService,
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
      const presetStrategies = await this.backtestService.getPresetStrategiesWithMetrics();
      
      let userStrategies: any[] = [];
      try {
        const dbStrategies = await this.prisma.strategy.findMany({
          where: { isPublic: true },
          orderBy: [{ lastBacktestProfit: 'desc' }, { updatedAt: 'desc' }],
          include: { user: { select: { name: true } } }
        });

        userStrategies = dbStrategies.map(s => ({
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

      return [...presetStrategies, ...userStrategies];
    } catch (error) {
      console.error('Failed to load strategies:', error.message);
      return this.backtestService.getStrategyTemplates();
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
  async runBacktest(@Req() req: AuthenticatedRequest, @Body() dto: RunBacktestDto) {
    const result = await this.backtestService.runBacktest(dto);
    
    if (result.status === 'success') {
      const userId = await this.getUserId(req);
      const saved = await this.backtestService.saveBacktestResult(userId, dto, result);
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
    
    const headers = ['Date', 'Time', 'Symbol', 'Action', 'Price', 'P&L %', 'P&L $', 'Equity', 'Reason', 'Indicators'];
    const rows = result.trades.map((t: any) => [
      t.date, t.time, t.symbol, t.action, t.price,
      t.profit_percent || '0', t.profit_usd || '0', t.equity,
      `"${t.reason || ''}"`,
      `"${(t.indicatorProof || []).map((p: any) => `${p.indicator}: ${p.value}`).join('; ')}"`
    ].join(','));
    
    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=backtest_${id}.csv`);
    return res.send(csv);
  }

  @UseGuards(JwtAuthGuard)
  @Post('results/:id/save-as-strategy')
  async saveAsStrategy(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: { name: string; description?: string }) {
    const userId = await this.getUserId(req);
    return this.backtestService.saveAsStrategy(userId, parseInt(id), body.name, body.description);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('results/:id')
  async deleteResult(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
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

  // Data status and management
  @Get('data/status')
  getDataStatus() {
    return this.backtestService.getDataStatus();
  }

  @Post('data/update')
  triggerDataUpdate() {
    return this.backtestService.triggerDataUpdate();
  }
}
