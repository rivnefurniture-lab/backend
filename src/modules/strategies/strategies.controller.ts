import { Body, Controller, Get, Post, Delete, Param, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { StrategiesService } from './strategies.service';
import { ExchangeService } from '../exchange/exchange.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

interface JwtUser {
  sub: string; // Supabase uses UUID strings
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
    private readonly prisma: PrismaService,
  ) {}

  // Get the supabase UUID from JWT
  private getSupabaseId(req: AuthenticatedRequest): string {
    return req.user?.sub || '';
  }
  
  private getEmail(req: AuthenticatedRequest): string {
    return req.user?.email || '';
  }
  
  // Find or create user and return their DB ID
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);
    
    try {
      // First try to find by supabaseId
      let user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: { id: true },
      });
      
      // If not found, try by email
      if (!user && email) {
        user = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        
        // Update supabaseId if found by email
        if (user && supabaseId) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { supabaseId },
          });
        }
      }
      
      // If still not found, create new user
      if (!user && email) {
        user = await this.prisma.user.create({
          data: {
            email,
            supabaseId,
            xp: 0,
            level: 1,
          },
          select: { id: true },
        });
      }
      
      return user?.id || 1;
    } catch (e) {
      console.error('Error getting user ID:', e);
      return 1; // Fallback
    }
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
      const userId = await this.getUserId(req);
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
    const userId = await this.getUserId(req);
    return this.strategies.getUserStrategies(userId);
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
    isPublic?: boolean;
    backtestResults?: Record<string, unknown>;
  }) {
    try {
      const userId = await this.getUserId(req);
      const strategy = await this.strategies.saveStrategy(userId, body);
      return { 
        success: true, 
        message: 'Strategy saved successfully!',
        strategy: {
          id: strategy.id,
          name: strategy.name,
          category: strategy.category,
        }
      };
    } catch (error) {
      console.error('Error saving strategy:', error);
      return { 
        success: false, 
        error: error.message || 'Failed to save strategy' 
      };
    }
  }

  // Update strategy
  @UseGuards(JwtAuthGuard)
  @Post(':id/update')
  async updateStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ) {
    const userId = await this.getUserId(req);
    return this.strategies.updateStrategy(userId, parseInt(id), body);
  }

  // Delete strategy
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteStrategy(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const userId = await this.getUserId(req);
    return this.strategies.deleteStrategy(userId, parseInt(id));
  }

  // Start a strategy (live trading)
  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  async startStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { initialBalance?: number; exchange?: string }
  ) {
    const userId = await this.getUserId(req);
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
    const userId = await this.getUserId(req);
    return this.strategies.stopStrategy(userId, parseInt(runId));
  }

  // Get running strategies
  @UseGuards(JwtAuthGuard)
  @Get('running')
  async getRunningStrategies(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.strategies.getRunningStrategies(userId);
  }

  // Get run details
  @UseGuards(JwtAuthGuard)
  @Get('runs/:runId')
  async getRunDetails(@Req() req: AuthenticatedRequest, @Param('runId') runId: string) {
    const userId = await this.getUserId(req);
    return this.strategies.getRunDetails(userId, parseInt(runId));
  }

  // List all active jobs (admin/monitoring)
  @Get('jobs')
  getJobs() {
    return this.strategies.listJobs();
  }
}
