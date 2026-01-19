import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { SubscriptionService, PlanType } from './subscription.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

interface JwtUser {
  sub: string;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('subscription')
export class SubscriptionController {
  // Cache for userId resolution
  private userIdCache: Map<string, { id: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly prisma: PrismaService,
  ) {}

  private getSupabaseId(req: AuthenticatedRequest): string {
    return req.user?.sub || '';
  }

  private getEmail(req: AuthenticatedRequest): string {
    return req.user?.email || '';
  }

  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

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

        if (user && supabaseId) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { supabaseId },
          });
        }
      }

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

      const userId = user?.id || 1;

      if (supabaseId && userId !== 1) {
        this.userIdCache.set(supabaseId, { id: userId, timestamp: Date.now() });
      }

      return userId;
    } catch {
      if (cached) {
        return cached.id;
      }
      return 1;
    }
  }

  /**
   * Get current subscription status
   */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  async getStatus(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.subscriptionService.getSubscriptionStatus(userId);
  }

  /**
   * Get available plans
   */
  @Get('plans')
  getPlans() {
    return {
      plans: [
        {
          id: 'free',
          name: 'Free',
          price: 0,
          priceYearly: 0,
          features: {
            backtestsPerDay: 3,
            maxSavedStrategies: 3,
            historicalDataYears: 1,
            indicators: 'basic',
            priorityQueue: false,
            exportReports: false,
            emailNotifications: false,
          },
        },
        {
          id: 'pro',
          name: 'Pro',
          price: 29,
          priceYearly: 23,
          features: {
            backtestsPerDay: 'unlimited',
            maxSavedStrategies: 'unlimited',
            historicalDataYears: 5,
            indicators: 'all',
            priorityQueue: false,
            exportReports: true,
            emailNotifications: true,
          },
        },
        {
          id: 'enterprise',
          name: 'Enterprise',
          price: 99,
          priceYearly: 79,
          features: {
            backtestsPerDay: 'unlimited',
            maxSavedStrategies: 'unlimited',
            historicalDataYears: 5,
            indicators: 'all',
            priorityQueue: true,
            exportReports: true,
            emailNotifications: true,
            apiAccess: true,
            dedicatedServer: true,
          },
        },
      ],
    };
  }

  /**
   * Check if user can run a backtest
   */
  @UseGuards(JwtAuthGuard)
  @Get('can-backtest')
  async canBacktest(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.subscriptionService.canRunBacktest(userId);
  }

  /**
   * Check if user can save a strategy
   */
  @UseGuards(JwtAuthGuard)
  @Get('can-save-strategy')
  async canSaveStrategy(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.subscriptionService.canSaveStrategy(userId);
  }

  /**
   * Activate subscription after payment (called by payment webhook)
   */
  @Post('activate')
  async activateSubscription(
    @Body() body: { userId: number; plan: PlanType; months: number; paymentId: string },
  ) {
    // In production, verify the payment with LiqPay before activating
    // This endpoint should be called from the payment callback
    
    await this.subscriptionService.updateSubscription(
      body.userId,
      body.plan,
      body.months,
    );

    return { success: true, message: 'Subscription activated' };
  }

  /**
   * Cancel subscription
   */
  @UseGuards(JwtAuthGuard)
  @Post('cancel')
  async cancelSubscription(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    await this.subscriptionService.cancelSubscription(userId);
    return { success: true, message: 'Subscription cancelled. Access continues until expiration.' };
  }
}

