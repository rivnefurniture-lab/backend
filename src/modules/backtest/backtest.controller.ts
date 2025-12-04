import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BacktestService } from './backtest.service';
import { DataFetcherService } from './data-fetcher.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('backtest')
export class BacktestController {
  constructor(
    private readonly backtestService: BacktestService,
    private readonly dataFetcher: DataFetcherService,
    private readonly prisma: PrismaService,
  ) {}

  // Get available indicators and their parameters
  @Get('indicators')
  getIndicators() {
    return this.backtestService.getAvailableIndicators();
  }

  // Get strategy templates
  @Get('templates')
  getTemplates() {
    return this.backtestService.getStrategyTemplates();
  }

  // Get available symbols with data
  @Get('symbols')
  getAvailableSymbols() {
    return this.dataFetcher.getAvailableSymbols();
  }

  // Get ALL strategies - preset templates + user-saved from database
  @Get('strategies')
  async getAllStrategies() {
    try {
      // Get preset strategies (always available)
      const presetStrategies = await this.backtestService.getPresetStrategiesWithMetrics();
      
      // Try to get user-saved strategies from database
      let userStrategies: any[] = [];
      try {
        const dbStrategies = await this.prisma.strategy.findMany({
          where: { isPublic: true },
          orderBy: [
            { lastBacktestProfit: 'desc' },
            { updatedAt: 'desc' }
          ],
          include: {
            user: {
              select: { name: true, email: true }
            }
          }
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
        console.error('Failed to load user strategies from DB:', dbError.message);
      }

      return [...presetStrategies, ...userStrategies];
    } catch (error) {
      console.error('Failed to load strategies:', error.message);
      return this.backtestService.getStrategyTemplates();
    }
  }

  // Get preset strategies with real calculated metrics
  @Get('preset-strategies')
  async getPresetStrategies() {
    return this.backtestService.getPresetStrategiesWithMetrics();
  }

  // Calculate real metrics for a specific preset strategy
  @Get('preset-strategies/:id/calculate')
  async calculatePresetStrategy(@Param('id') id: string) {
    return this.backtestService.calculatePresetStrategyMetrics(id);
  }

  // Run a backtest (requires auth)
  @UseGuards(JwtAuthGuard)
  @Post('run')
  async runBacktest(@Req() req: any, @Body() dto: RunBacktestDto) {
    const result = await this.backtestService.runBacktest(dto);
    
    // Save result to database
    if (result.status === 'success') {
      const userId = req.user?.sub || 1;
      const saved = await this.backtestService.saveBacktestResult(userId, dto, result);
      return { ...result, savedId: saved.id };
    }
    
    return result;
  }

  // Public endpoint to run demo backtest (no auth required for testing)
  @Post('demo')
  async runDemoBacktest(@Body() dto: RunBacktestDto) {
    return this.backtestService.runBacktest(dto);
  }

  // Get past backtest results for user
  @UseGuards(JwtAuthGuard)
  @Get('results')
  async getResults(@Req() req: any) {
    const userId = req.user?.sub || 1;
    return this.backtestService.getBacktestResults(userId);
  }

  // Get single backtest result with details
  @UseGuards(JwtAuthGuard)
  @Get('results/:id')
  async getResult(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub || 1;
    return this.backtestService.getBacktestResult(parseInt(id), userId);
  }

  // Export trades as CSV
  @Get('results/:id/export/csv')
  async exportCSV(@Param('id') id: string, @Res() res: Response) {
    const result = await this.backtestService.getBacktestResult(parseInt(id));
    
    if (!result || !result.trades) {
      return res.status(404).json({ error: 'Backtest result not found' });
    }
    
    const trades = result.trades;
    
    // Create CSV header
    const headers = [
      'Date', 'Time', 'Symbol', 'Action', 'Price', 'Quantity', 'Amount',
      'P&L %', 'P&L $', 'Equity', 'Drawdown %', 'Reason', 'Indicators'
    ];
    
    // Create CSV rows
    const rows = trades.map((t: any) => [
      t.date,
      t.time,
      t.symbol,
      t.action,
      t.price,
      t.quantity?.toFixed(6) || '',
      t.amount?.toFixed(2) || '',
      t.profit_percent?.toFixed(2) || '0',
      t.profit_usd?.toFixed(2) || '0',
      t.equity?.toFixed(2) || '',
      t.drawdown?.toFixed(2) || '0',
      t.reason || '',
      (t.indicatorProof || []).map((p: any) => 
        `${p.indicator}: ${p.value} ${p.condition} ${p.target}`
      ).join(' | ')
    ].join(','));
    
    const csv = [headers.join(','), ...rows].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=backtest_${id}_trades.csv`);
    return res.send(csv);
  }

  // Save backtest result as a reusable strategy
  @UseGuards(JwtAuthGuard)
  @Post('results/:id/save-as-strategy')
  async saveAsStrategy(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name: string; description?: string }
  ) {
    const userId = req.user?.sub || 1;
    return this.backtestService.saveAsStrategy(userId, parseInt(id), body.name, body.description);
  }

  // Delete backtest result
  @UseGuards(JwtAuthGuard)
  @Delete('results/:id')
  async deleteResult(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub || 1;
    return this.backtestService.deleteBacktestResult(parseInt(id), userId);
  }
}
