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
   * Only counts "meaningful" backtests:
   * - Completed successfully (status = 'completed')
   * - Has valid results (not NaN, not 0 profit)
   * - Has at least 10 trades
   * - Has at least 10% profit (to exclude trivial/failed tests)
   * 
   * WHY results can be 0 or NaN:
   * - 0 profit: No trades executed (conditions never met), or all trades broke even
   * - NaN: Division by zero in metrics (e.g., Sharpe ratio with 0 std dev), 
   *        missing data for the period, or calculation errors
   */
  async getBacktestsToday(userId: number): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Count only meaningful backtests that actually ran successfully
    const count = await this.prisma.backtestQueue.count({
      where: {
        userId,
        createdAt: { gte: today },
        status: 'completed', // Only completed backtests
        resultId: { not: null }, // Has a result
      },
    });

    // Additionally check the results quality
    const results = await this.prisma.backtestResult.findMany({
      where: {
        userId,
        createdAt: { gte: today },
      },
      select: {
        totalTrades: true,
        netProfit: true,
        yearlyReturn: true,
      },
    });

    // Count only backtests with meaningful results:
    // - At least 10 trades
    // - Profit is not NaN and not exactly 0
    // - Yearly return >= 10% (0.10 as decimal)
    const meaningfulCount = results.filter(r => 
      r.totalTrades >= 10 && 
      r.netProfit !== null && 
      !isNaN(r.netProfit) && 
      r.netProfit !== 0 &&
      r.yearlyReturn !== null &&
      !isNaN(r.yearlyReturn) &&
      Math.abs(r.yearlyReturn) >= 0.10
    ).length;

    return meaningfulCount;
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

  // ==================== ADMIN FUNCTIONS ====================

  /**
   * [ADMIN] Get all users with their subscription info
   */
  async getAllUsersSubscriptions(): Promise<any[]> {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpires: true,
        createdAt: true,
        _count: {
          select: {
            strategies: true,
            backtestResults: true,
            backtestQueue: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      plan: u.subscriptionPlan || 'free',
      status: u.subscriptionStatus || 'none',
      expiresAt: u.subscriptionExpires,
      createdAt: u.createdAt,
      isActive: u.subscriptionStatus === 'active' && 
        (!u.subscriptionExpires || new Date(u.subscriptionExpires) > new Date()),
      daysRemaining: u.subscriptionExpires 
        ? Math.max(0, Math.ceil((new Date(u.subscriptionExpires).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null,
      stats: {
        strategies: u._count.strategies,
        backtests: u._count.backtestResults,
        queueItems: u._count.backtestQueue,
      },
    }));
  }

  /**
   * [ADMIN] Grant subscription access to a user
   */
  async grantAccess(
    userId: number,
    plan: PlanType,
    days: number,
    grantedBy: string,
  ): Promise<{ success: boolean; message: string; expiresAt: Date }> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionPlan: plan,
        subscriptionStatus: 'active',
        subscriptionExpires: expiresAt,
      },
    });

    // Log the grant action (you could create an audit log table for this)
    console.log(`[ADMIN] ${grantedBy} granted ${plan} access to user ${userId} for ${days} days (expires: ${expiresAt.toISOString()})`);

    return {
      success: true,
      message: `Granted ${plan} access for ${days} days`,
      expiresAt,
    };
  }

  /**
   * [ADMIN] Revoke subscription access from a user
   */
  async revokeAccess(
    userId: number,
    revokedBy: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionPlan: 'free',
        subscriptionStatus: 'revoked',
        subscriptionExpires: null,
      },
    });

    console.log(`[ADMIN] ${revokedBy} revoked subscription from user ${userId}`);

    return {
      success: true,
      message: 'Subscription access revoked',
    };
  }

  /**
   * [ADMIN] Get user's subscription details by email
   */
  async getUserByEmail(email: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpires: true,
        createdAt: true,
        _count: {
          select: {
            strategies: true,
            backtestResults: true,
            backtestQueue: true,
          },
        },
      },
    });

    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.subscriptionPlan || 'free',
      status: user.subscriptionStatus || 'none',
      expiresAt: user.subscriptionExpires,
      createdAt: user.createdAt,
      isActive: user.subscriptionStatus === 'active' && 
        (!user.subscriptionExpires || new Date(user.subscriptionExpires) > new Date()),
      stats: {
        strategies: user._count.strategies,
        backtests: user._count.backtestResults,
        queueItems: user._count.backtestQueue,
      },
    };
  }

  /**
   * [ADMIN] Get backtest quality stats (for understanding NaN/0 results)
   */
  async getBacktestQualityStats(): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const allBacktests = await this.prisma.backtestResult.findMany({
      select: {
        id: true,
        name: true,
        totalTrades: true,
        netProfit: true,
        yearlyReturn: true,
        createdAt: true,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const stats = {
      total: allBacktests.length,
      withZeroProfit: 0,
      withNaNProfit: 0,
      withLessThan10Trades: 0,
      withLessThan10PercentReturn: 0,
      meaningful: 0,
      recentBacktests: [] as any[],
    };

    for (const bt of allBacktests) {
      const isNaN = bt.netProfit === null || Number.isNaN(bt.netProfit);
      const isZero = bt.netProfit === 0;
      const fewTrades = (bt.totalTrades || 0) < 10;
      const lowReturn = bt.yearlyReturn !== null && Math.abs(bt.yearlyReturn) < 0.10;

      if (isNaN) stats.withNaNProfit++;
      if (isZero) stats.withZeroProfit++;
      if (fewTrades) stats.withLessThan10Trades++;
      if (lowReturn) stats.withLessThan10PercentReturn++;
      
      if (!isNaN && !isZero && !fewTrades && !lowReturn) {
        stats.meaningful++;
      }

      stats.recentBacktests.push({
        id: bt.id,
        name: bt.name,
        email: bt.user?.email,
        trades: bt.totalTrades,
        profit: bt.netProfit,
        yearlyReturn: bt.yearlyReturn ? (bt.yearlyReturn * 100).toFixed(2) + '%' : 'N/A',
        createdAt: bt.createdAt,
        isMeaningful: !isNaN && !isZero && !fewTrades && !lowReturn,
        issues: [
          isNaN && 'NaN profit',
          isZero && 'Zero profit',
          fewTrades && '<10 trades',
          lowReturn && '<10% return',
        ].filter(Boolean),
      });
    }

    return {
      ...stats,
      explanation: {
        zeroProfit: 'No trades were executed (entry conditions never met) or all trades broke even.',
        nanProfit: 'Calculation error - usually division by zero in metrics (e.g., Sharpe ratio with 0 standard deviation), missing price data for the selected period, or incomplete backtest.',
        fewTrades: 'Strategy is too conservative or period too short - not enough data to be statistically meaningful.',
        lowReturn: 'Strategy performance is negligible - likely random noise rather than actual edge.',
      },
    };
  }
}

