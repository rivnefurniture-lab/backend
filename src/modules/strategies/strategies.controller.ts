import { Body, Controller, Get, Post, Delete, Param, UseGuards, Req } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Controller('strategies')
export class StrategiesController {
  constructor(
    private readonly strategies: StrategiesService,
    private readonly exchange: ExchangeService,
  ) {}

  // Get user's saved strategies
  @UseGuards(JwtAuthGuard)
  @Get('my')
  async getMyStrategies(@Req() req: any) {
    const userId = req.user?.sub || 1; // Fallback for dev
    return this.strategies.getUserStrategies(userId);
  }

  // Save a new strategy
  @UseGuards(JwtAuthGuard)
  @Post('save')
  async saveStrategy(@Req() req: any, @Body() body: {
    name: string;
    description?: string;
    category?: string;
    config: any;
    pairs: string[];
    maxDeals?: number;
    orderSize?: number;
    backtestResults?: any;
  }) {
    const userId = req.user?.sub || 1;
    return this.strategies.saveStrategy(userId, body);
  }

  // Update strategy
  @UseGuards(JwtAuthGuard)
  @Post(':id/update')
  async updateStrategy(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: any
  ) {
    const userId = req.user?.sub || 1;
    return this.strategies.updateStrategy(userId, parseInt(id), body);
  }

  // Delete strategy
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteStrategy(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub || 1;
    return this.strategies.deleteStrategy(userId, parseInt(id));
  }

  // Start a strategy (live trading)
  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  async startStrategy(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { initialBalance?: number }
  ) {
    const userId = req.user?.sub || 1;
    const conn = this.exchange.getConnection('binance');
    
    if (!conn?.instance) {
      return { error: 'Exchange not connected. Please connect your Binance account first.' };
    }

    return this.strategies.startStrategy(
      userId,
      parseInt(id),
      conn.instance,
      body.initialBalance || 5000
    );
  }

  // Stop a running strategy
  @UseGuards(JwtAuthGuard)
  @Post('runs/:runId/stop')
  async stopStrategy(@Req() req: any, @Param('runId') runId: string) {
    const userId = req.user?.sub || 1;
    return this.strategies.stopStrategy(userId, parseInt(runId));
  }

  // Get running strategies
  @UseGuards(JwtAuthGuard)
  @Get('running')
  async getRunningStrategies(@Req() req: any) {
    const userId = req.user?.sub || 1;
    return this.strategies.getRunningStrategies(userId);
  }

  // Get run details
  @UseGuards(JwtAuthGuard)
  @Get('runs/:runId')
  async getRunDetails(@Req() req: any, @Param('runId') runId: string) {
    const userId = req.user?.sub || 1;
    return this.strategies.getRunDetails(userId, parseInt(runId));
  }

  // List all active jobs (admin/monitoring)
  @Get('jobs')
  getJobs() {
    return this.strategies.listJobs();
  }
}
