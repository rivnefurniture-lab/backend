import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import {
  SubscriptionService,
  PLAN_LIMITS,
} from '../subscription/subscription.service';

interface JwtUser {
  sub: string; // Supabase uses UUID strings
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  // Cache for user lookups
  private userCache: Map<string, { user: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  // Get the supabase UUID from JWT
  private getSupabaseId(req: AuthenticatedRequest): string {
    return req.user?.sub || '';
  }

  private getEmail(req: AuthenticatedRequest): string {
    return req.user?.email || '';
  }

  // Retry wrapper for database operations
  private async withRetry<T>(
    operation: () => Promise<T>,
    retries = 2,
  ): Promise<T> {
    for (let i = 0; i <= retries; i++) {
      try {
        return await operation();
      } catch (e: any) {
        const isConnectionError =
          e.message?.includes("Can't reach database") ||
          e.code === 'P1001' ||
          e.code === 'P1002';
        if (isConnectionError && i < retries) {
          console.log(
            `DB connection failed, retrying (${i + 1}/${retries})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1))); // Exponential backoff
          continue;
        }
        throw e;
      }
    }
    throw new Error('Max retries exceeded');
  }

  // Find or create user by supabaseId (with caching and retry)
  private async findOrCreateUser(supabaseId: string, email: string) {
    if (!supabaseId && !email) {
      return null;
    }

    // Check cache first
    const cacheKey = supabaseId || email;
    const cached = this.userCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.user;
    }

    return this.withRetry(async () => {
      // First try to find by supabaseId
      let user = supabaseId
        ? await this.prisma.user.findFirst({
            where: { supabaseId },
          })
        : null;

      // If not found, try by email
      if (!user && email) {
        user = await this.prisma.user.findUnique({
          where: { email },
        });

        // If found by email, update the supabaseId
        if (user && supabaseId) {
          user = await this.prisma.user.update({
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
            supabaseId: supabaseId || undefined,
            xp: 0,
            level: 1,
          },
        });
      }

      // Cache the result
      if (user) {
        this.userCache.set(cacheKey, { user, timestamp: Date.now() });
      }

      return user;
    });
  }

  @Get('profile')
  async getProfile(@Req() req: AuthenticatedRequest) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      const user = await this.findOrCreateUser(supabaseId, email);

      if (!user) {
        return { error: 'User not found' };
      }

      // Parse achievements
      let achievements = [];
      try {
        achievements = user.achievements ? JSON.parse(user.achievements) : [];
      } catch {}

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        country: user.country,
        profilePhoto: user.profilePhoto,
        xp: user.xp,
        level: user.level,
        achievements,
        subscriptionPlan: user.subscriptionPlan,
        subscriptionStatus: user.subscriptionStatus,
        telegramEnabled: user.telegramEnabled,
        emailNotifications: user.emailNotifications,
        notifyOnTrade: user.notifyOnTrade,
        notifyOnBacktest: user.notifyOnBacktest,
        notifyOnBalance: user.notifyOnBalance,
        createdAt: user.createdAt,
      };
    } catch (e) {
      console.error('Error fetching profile:', e);
      return { error: 'Failed to fetch profile', details: e.message };
    }
  }

  /**
   * Get user's current plan limits and usage
   * This provides a clear overview of what features are available
   * and how much of the quota has been used
   */
  @Get('limits')
  async getLimits(@Req() req: AuthenticatedRequest) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      const user = await this.findOrCreateUser(supabaseId, email);

      if (!user) {
        // Return free plan limits for anonymous users
        const freeLimits = PLAN_LIMITS.free;
        return {
          plan: 'free',
          isActive: false,
          expiresAt: null,
          limits: {
            backtestsPerDay: freeLimits.backtestsPerDay,
            maxSavedStrategies: freeLimits.maxSavedStrategies,
            historicalDataYears: freeLimits.historicalDataYears,
            indicators: freeLimits.indicators,
            priorityQueue: freeLimits.priorityQueue,
            exportReports: freeLimits.exportReports,
            emailNotifications: freeLimits.emailNotifications,
          },
          usage: {
            backtestsToday: 0,
            savedStrategies: 0,
          },
          remaining: {
            backtestsToday: freeLimits.backtestsPerDay,
            savedStrategies: freeLimits.maxSavedStrategies,
          },
          canRunBacktest: true,
          canSaveStrategy: true,
        };
      }

      // Get full subscription status from service
      const status =
        await this.subscriptionService.getSubscriptionStatus(user.id);

      // Calculate remaining quotas
      const remaining = {
        backtestsToday:
          status.limits.backtestsPerDay === -1
            ? 'unlimited'
            : Math.max(
                0,
                status.limits.backtestsPerDay - status.usage.backtestsToday,
              ),
        savedStrategies:
          status.limits.maxSavedStrategies === -1
            ? 'unlimited'
            : Math.max(
                0,
                status.limits.maxSavedStrategies - status.usage.savedStrategies,
              ),
      };

      return {
        plan: status.plan,
        isActive: status.isActive,
        expiresAt: status.expiresAt,
        limits: {
          backtestsPerDay:
            status.limits.backtestsPerDay === -1
              ? 'unlimited'
              : status.limits.backtestsPerDay,
          maxSavedStrategies:
            status.limits.maxSavedStrategies === -1
              ? 'unlimited'
              : status.limits.maxSavedStrategies,
          historicalDataYears: status.limits.historicalDataYears,
          indicators: status.limits.indicators,
          priorityQueue: status.limits.priorityQueue,
          exportReports: status.limits.exportReports,
          emailNotifications: status.limits.emailNotifications,
          apiAccess: status.limits.apiAccess || false,
          dedicatedServer: status.limits.dedicatedServer || false,
        },
        usage: {
          backtestsToday: status.usage.backtestsToday,
          savedStrategies: status.usage.savedStrategies,
        },
        remaining,
        canRunBacktest: status.canRunBacktest,
        canSaveStrategy: status.canSaveStrategy,
      };
    } catch (e) {
      console.error('Error fetching limits:', e);
      return { error: 'Failed to fetch limits', details: e.message };
    }
  }

  @Post('profile')
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      name?: string;
      phone?: string;
      country?: string;
      profilePhoto?: string; // Base64 or URL
    },
  ) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      // First, find or create the user
      const existingUser = await this.findOrCreateUser(supabaseId, email);

      if (!existingUser) {
        return { error: 'Could not find or create user' };
      }

      // Build update data - only include defined values
      const updateData: any = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.phone !== undefined) updateData.phone = body.phone;
      if (body.country !== undefined) updateData.country = body.country;
      if (body.profilePhoto !== undefined)
        updateData.profilePhoto = body.profilePhoto;

      const user = await this.prisma.user.update({
        where: { id: existingUser.id },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          country: true,
          profilePhoto: true,
        },
      });

      console.log(
        'Profile updated successfully:',
        user.id,
        'Photo:',
        body.profilePhoto
          ? 'yes (length: ' + body.profilePhoto.length + ')'
          : 'no',
      );
      return { success: true, user };
    } catch (e) {
      console.error('Error updating profile:', e);
      return { error: 'Failed to update profile', details: e.message };
    }
  }

  @Post('notifications')
  async updateNotifications(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      telegramId?: string;
      telegramEnabled?: boolean;
      emailNotifications?: boolean;
      notifyOnTrade?: boolean;
      notifyOnBacktest?: boolean;
      notifyOnBalance?: boolean;
    },
  ) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      const user = await this.findOrCreateUser(supabaseId, email);
      if (!user) return { error: 'User not found' };

      await this.prisma.user.update({
        where: { id: user.id },
        data: body,
      });

      return { success: true };
    } catch (e) {
      console.error('Error updating notifications:', e);
      return { error: 'Failed to update notification settings' };
    }
  }

  @Post('xp/add')
  async addXP(
    @Req() req: AuthenticatedRequest,
    @Body() body: { amount: number; reason: string },
  ) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      const user = await this.findOrCreateUser(supabaseId, email);
      if (!user) return { error: 'User not found' };

      const newXP = (user.xp || 0) + body.amount;
      // Level up every 1000 XP
      const newLevel = Math.floor(newXP / 1000) + 1;

      await this.prisma.user.update({
        where: { id: user.id },
        data: { xp: newXP, level: newLevel },
      });

      return {
        success: true,
        xp: newXP,
        level: newLevel,
        leveledUp: newLevel > (user.level || 1),
      };
    } catch (e) {
      console.error('Error adding XP:', e);
      return { error: 'Failed to add XP' };
    }
  }

  @Get('stats')
  async getUserStats(@Req() req: AuthenticatedRequest) {
    const supabaseId = this.getSupabaseId(req);
    const email = this.getEmail(req);

    try {
      const user = await this.findOrCreateUser(supabaseId, email);
      if (!user) {
        return {
          xp: 0,
          level: 1,
          achievements: [],
          strategiesCreated: 0,
          backtestsRun: 0,
          tradesExecuted: 0,
          totalProfit: 0,
          winRate: 0,
        };
      }

      const [strategiesCount, backtestsCount, allTrades, runningStrategies] =
        await Promise.all([
          this.prisma.strategy.count({ where: { userId: user.id } }),
          this.prisma.backtestResult.count({ where: { userId: user.id } }),
          this.prisma.trade.findMany({ where: { userId: user.id } }),
          this.prisma.strategyRun.count({
            where: { userId: user.id, status: 'running' },
          }),
        ]);

      // Calculate trade stats - only count closed trades for win rate
      const closedTrades = allTrades.filter((t) => t.exitPrice !== null);
      const totalProfit = closedTrades.reduce(
        (sum, t) => sum + (t.profitLoss || 0),
        0,
      );
      const winningTrades = closedTrades.filter(
        (t) => (t.profitLoss || 0) > 0,
      ).length;
      const winRate =
        closedTrades.length > 0
          ? (winningTrades / closedTrades.length) * 100
          : 0;
      const tradesCount = allTrades.length;

      let achievements = [];
      try {
        achievements = user.achievements ? JSON.parse(user.achievements) : [];
      } catch {}

      return {
        xp: user.xp || 0,
        level: user.level || 1,
        achievements,
        strategiesCreated: strategiesCount,
        backtestsRun: backtestsCount,
        tradesExecuted: tradesCount,
        totalProfit,
        winRate,
        winningTrades,
        closedTrades: closedTrades.length,
        runningStrategies,
        memberSince: user.createdAt,
      };
    } catch (e) {
      console.error('Error fetching stats:', e);
      return {
        xp: 0,
        level: 1,
        achievements: [],
        strategiesCreated: 0,
        backtestsRun: 0,
        tradesExecuted: 0,
        totalProfit: 0,
        winRate: 0,
        winningTrades: 0,
        closedTrades: 0,
        runningStrategies: 0,
      };
    }
  }
}
