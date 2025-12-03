import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

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
