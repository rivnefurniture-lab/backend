import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Plan limits interface
export interface PlanLimits {
  backtestsPerDay: number;
  maxSavedStrategies: number;
  historicalDataYears: number;
  indicators: string[] | 'all';
  priorityQueue: boolean;
  exportReports: boolean;
  emailNotifications: boolean;
  apiAccess?: boolean;
  dedicatedServer?: boolean;
}

// Plan definitions with limits
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    backtestsPerDay: 3,
    maxSavedStrategies: 3,
    historicalDataYears: 1,
    indicators: ['RSI', 'MACD', 'MA', 'BollingerBands'], // Basic indicators
    priorityQueue: false,
    exportReports: false,
    emailNotifications: false,
  },
  pro: {
    backtestsPerDay: -1, // Unlimited
    maxSavedStrategies: -1, // Unlimited
    historicalDataYears: 5,
    indicators: 'all', // All indicators
    priorityQueue: false,
    exportReports: true,
    emailNotifications: true,
  },
  enterprise: {
    backtestsPerDay: -1, // Unlimited
    maxSavedStrategies: -1, // Unlimited
    historicalDataYears: 5,
    indicators: 'all',
    priorityQueue: true,
    exportReports: true,
    emailNotifications: true,
    apiAccess: true,
    dedicatedServer: true,
  },
};

export type PlanType = 'free' | 'pro' | 'enterprise';

export interface SubscriptionStatus {
  plan: PlanType;
  isActive: boolean;
  expiresAt: Date | null;
  limits: PlanLimits;
  usage: {
    backtestsToday: number;
    savedStrategies: number;
  };
  canRunBacktest: boolean;
  canSaveStrategy: boolean;
}

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get user's current plan (defaults to 'free')
   */
  async getUserPlan(userId: number): Promise<PlanType> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpires: true,
      },
    });

    if (!user) return 'free';

    // Check if subscription is active and not expired
    const isActive = user.subscriptionStatus === 'active';
    const isNotExpired = !user.subscriptionExpires || new Date(user.subscriptionExpires) > new Date();

    if (isActive && isNotExpired && user.subscriptionPlan) {
      const plan = user.subscriptionPlan.toLowerCase() as PlanType;
      if (plan in PLAN_LIMITS) {
        return plan;
      }
    }

    return 'free';
  }

  /**
   * Get plan limits for a specific plan
   */
  getPlanLimits(plan: PlanType): PlanLimits {
    return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  }

  /**
   * Count backtests run by user today
   */
  async getBacktestsToday(userId: number): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const count = await this.prisma.backtestQueue.count({
      where: {
        userId,
        createdAt: { gte: today },
      },
    });

    return count;
  }

  /**
   * Count user's saved strategies
   */
  async getSavedStrategiesCount(userId: number): Promise<number> {
    const count = await this.prisma.strategy.count({
      where: { userId },
    });

    return count;
  }

  /**
   * Check if user can run a backtest
   */
  async canRunBacktest(userId: number): Promise<{ allowed: boolean; reason?: string }> {
    const plan = await this.getUserPlan(userId);
    const limits = this.getPlanLimits(plan);
    
    // Unlimited backtests
    if (limits.backtestsPerDay === -1) {
      return { allowed: true };
    }

    const backtestsToday = await this.getBacktestsToday(userId);
    
    if (backtestsToday >= limits.backtestsPerDay) {
      return {
        allowed: false,
        reason: `You've reached your daily limit of ${limits.backtestsPerDay} backtests. Upgrade to Pro for unlimited backtests.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can save a strategy
   */
  async canSaveStrategy(userId: number): Promise<{ allowed: boolean; reason?: string }> {
    const plan = await this.getUserPlan(userId);
    const limits = this.getPlanLimits(plan);
    
    // Unlimited strategies
    if (limits.maxSavedStrategies === -1) {
      return { allowed: true };
    }

    const savedCount = await this.getSavedStrategiesCount(userId);
    
    if (savedCount >= limits.maxSavedStrategies) {
      return {
        allowed: false,
        reason: `You've reached your limit of ${limits.maxSavedStrategies} saved strategies. Upgrade to Pro for unlimited strategies.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if indicator is available for user's plan
   */
  async canUseIndicator(userId: number, indicator: string): Promise<boolean> {
    const plan = await this.getUserPlan(userId);
    const limits = this.getPlanLimits(plan);
    
    if (limits.indicators === 'all') {
      return true;
    }

    return (limits.indicators as string[]).includes(indicator);
  }

  /**
   * Get full subscription status for a user
   */
  async getSubscriptionStatus(userId: number): Promise<SubscriptionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpires: true,
      },
    });

    const plan = await this.getUserPlan(userId);
    const limits = this.getPlanLimits(plan);
    const backtestsToday = await this.getBacktestsToday(userId);
    const savedStrategies = await this.getSavedStrategiesCount(userId);

    const canBacktest = await this.canRunBacktest(userId);
    const canSave = await this.canSaveStrategy(userId);

    return {
      plan,
      isActive: user?.subscriptionStatus === 'active',
      expiresAt: user?.subscriptionExpires || null,
      limits,
      usage: {
        backtestsToday,
        savedStrategies,
      },
      canRunBacktest: canBacktest.allowed,
      canSaveStrategy: canSave.allowed,
    };
  }

  /**
   * Update user's subscription (called after successful payment)
   */
  async updateSubscription(
    userId: number,
    plan: PlanType,
    durationMonths: number,
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionPlan: plan,
        subscriptionStatus: 'active',
        subscriptionExpires: expiresAt,
      },
    });
  }

  /**
   * Cancel subscription (keeps access until expiration)
   */
  async cancelSubscription(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionStatus: 'cancelled',
      },
    });
  }

  /**
   * Check and update expired subscriptions
   */
  async checkExpiredSubscriptions(): Promise<number> {
    const result = await this.prisma.user.updateMany({
      where: {
        subscriptionStatus: 'active',
        subscriptionExpires: { lt: new Date() },
      },
      data: {
        subscriptionStatus: 'expired',
        subscriptionPlan: 'free',
      },
    });

    return result.count;
  }
}

