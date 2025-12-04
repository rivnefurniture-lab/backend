import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('backtest')
export class BacktestController {
  constructor(
    private readonly backtestService: BacktestService,
    private readonly prisma: PrismaService,
  ) {}

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
  async runBacktest(@Req() req: any, @Body() dto: RunBacktestDto) {
    const result = await this.backtestService.runBacktest(dto);
    
    if (result.status === 'success') {
      const userId = req.user?.sub || 1;
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
  async getResults(@Req() req: any) {
    return this.backtestService.getBacktestResults(req.user?.sub || 1);
  }

  @UseGuards(JwtAuthGuard)
  @Get('results/:id')
  async getResult(@Req() req: any, @Param('id') id: string) {
    return this.backtestService.getBacktestResult(parseInt(id), req.user?.sub || 1);
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
  async saveAsStrategy(@Req() req: any, @Param('id') id: string, @Body() body: { name: string; description?: string }) {
    return this.backtestService.saveAsStrategy(req.user?.sub || 1, parseInt(id), body.name, body.description);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('results/:id')
  async deleteResult(@Req() req: any, @Param('id') id: string) {
    return this.backtestService.deleteBacktestResult(parseInt(id), req.user?.sub || 1);
  }
}
