import { Body, Controller, Get, Post, Delete, Param, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { StrategiesService } from './strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

interface JwtUser {
  sub: number;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('strategies')
export class StrategiesController {
  constructor(
    private readonly strategies: StrategiesService,
    private readonly exchange: ExchangeService,
  ) {}

  private getUserId(req: AuthenticatedRequest): number {
    return req.user?.sub || 1;
  }

  // Start strategy directly with config (for preset strategies)
  @UseGuards(JwtAuthGuard)
  @Post('start')
  async startWithConfig(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      strategyId: string;
      config: string;
      exchange: string;
      symbol: string;
      timeframe: string;
      orderSize: number;
    }
  ) {
    try {
      const userId = this.getUserId(req);
      const exchangeName = body.exchange || 'binance';
      const conn = this.exchange.getConnection(exchangeName, userId);
      
      if (!conn?.instance) {
        return { error: `${exchangeName} not connected. Please connect your account first on the Connect page.` };
      }

      // Parse config safely
      let config;
      try {
        config = typeof body.config === 'string' ? JSON.parse(body.config) : body.config;
      } catch (e) {
        return { error: 'Invalid strategy configuration' };
      }

      // Create a temp strategy and start it
      const strategy = await this.strategies.saveStrategy(userId, {
        name: `Live: ${body.strategyId}`,
        description: `Started from preset ${body.strategyId}`,
        config,
        pairs: [body.symbol],
        orderSize: body.orderSize,
      });

      const result = await this.strategies.startStrategy(
        userId,
        strategy.id,
        conn.instance,
        body.orderSize * 5 // Use 5x order size as initial balance
      );

      return { 
        ...result, 
        message: 'Strategy started successfully! Check your Dashboard to monitor.',
        strategyId: strategy.id 
      };
    } catch (error) {
      console.error('Error starting strategy:', error);
      return { error: error.message || 'Failed to start strategy. Please try again.' };
    }
  }

  // Get user's saved strategies
  @UseGuards(JwtAuthGuard)
  @Get('my')
  async getMyStrategies(@Req() req: AuthenticatedRequest) {
    return this.strategies.getUserStrategies(this.getUserId(req));
  }

  // Save a new strategy
  @UseGuards(JwtAuthGuard)
  @Post('save')
  async saveStrategy(@Req() req: AuthenticatedRequest, @Body() body: {
    name: string;
    description?: string;
    category?: string;
    config: Record<string, unknown>;
    pairs: string[];
    maxDeals?: number;
    orderSize?: number;
    backtestResults?: Record<string, unknown>;
  }) {
    return this.strategies.saveStrategy(this.getUserId(req), body);
  }

  // Update strategy
  @UseGuards(JwtAuthGuard)
  @Post(':id/update')
  async updateStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ) {
    return this.strategies.updateStrategy(this.getUserId(req), parseInt(id), body);
  }

  // Delete strategy
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteStrategy(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.strategies.deleteStrategy(this.getUserId(req), parseInt(id));
  }

  // Start a strategy (live trading)
  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  async startStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { initialBalance?: number; exchange?: string }
  ) {
    const userId = this.getUserId(req);
    const exchangeName = body.exchange || 'binance';
    const conn = this.exchange.getConnection(exchangeName, userId);
    
    if (!conn?.instance) {
      return { error: `${exchangeName} not connected. Please connect your exchange account first on the Connect page.` };
    }

    const result = await this.strategies.startStrategy(
      userId,
      parseInt(id),
      conn.instance,
      body.initialBalance || 5000
    );

    return {
      ...result,
      message: 'Strategy started successfully! Check your Dashboard to monitor.',
    };
  }

  // Stop a running strategy
  @UseGuards(JwtAuthGuard)
  @Post('runs/:runId/stop')
  async stopStrategy(@Req() req: AuthenticatedRequest, @Param('runId') runId: string) {
    return this.strategies.stopStrategy(this.getUserId(req), parseInt(runId));
  }

  // Get running strategies
  @UseGuards(JwtAuthGuard)
  @Get('running')
  async getRunningStrategies(@Req() req: AuthenticatedRequest) {
    return this.strategies.getRunningStrategies(this.getUserId(req));
  }

  // Get run details
  @UseGuards(JwtAuthGuard)
  @Get('runs/:runId')
  async getRunDetails(@Req() req: AuthenticatedRequest, @Param('runId') runId: string) {
    return this.strategies.getRunDetails(this.getUserId(req), parseInt(runId));
  }

  // List all active jobs (admin/monitoring)
  @Get('jobs')
  getJobs() {
    return this.strategies.listJobs();
  }
}
