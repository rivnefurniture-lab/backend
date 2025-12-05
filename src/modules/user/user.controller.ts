import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

interface JwtUser {
  sub: number;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(private readonly prisma: PrismaService) {}

  private getUserId(req: AuthenticatedRequest): number {
    return req.user?.sub || 1;
  }

  @Get('profile')
  async getProfile(@Req() req: AuthenticatedRequest) {
    const userId = this.getUserId(req);
    const email = req.user?.email;
    
    try {
      // First try to find by ID
      let user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          country: true,
          profilePhoto: true,
          xp: true,
          level: true,
          achievements: true,
          subscriptionPlan: true,
          subscriptionStatus: true,
          telegramEnabled: true,
          emailNotifications: true,
          notifyOnTrade: true,
          notifyOnBacktest: true,
          notifyOnBalance: true,
          createdAt: true,
        },
      });
      
      // If not found and we have email, try to find by email or create
      if (!user && email) {
        user = await this.prisma.user.upsert({
          where: { email },
          create: {
            email,
            supabaseId: String(userId),
            xp: 0,
            level: 1,
          },
          update: {},
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            country: true,
            profilePhoto: true,
            xp: true,
            level: true,
            achievements: true,
            subscriptionPlan: true,
            subscriptionStatus: true,
            telegramEnabled: true,
            emailNotifications: true,
            notifyOnTrade: true,
            notifyOnBacktest: true,
            notifyOnBalance: true,
            createdAt: true,
          },
        });
      }
      
      if (!user) {
        return { error: 'User not found', id: userId };
      }
      
      // Parse achievements
      let achievements = [];
      try {
        achievements = user.achievements ? JSON.parse(user.achievements) : [];
      } catch {}
      
      return {
        ...user,
        achievements,
      };
    } catch (e) {
      console.error('Error fetching profile:', e);
      return { error: 'Failed to fetch profile', details: e.message };
    }
  }

  @Post('profile')
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      name?: string;
      phone?: string;
      country?: string;
      profilePhoto?: string; // Base64 or URL
    }
  ) {
    const userId = this.getUserId(req);
    const email = req.user?.email;
    
    try {
      // Build update data - only include defined values
      const updateData: any = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.phone !== undefined) updateData.phone = body.phone;
      if (body.country !== undefined) updateData.country = body.country;
      if (body.profilePhoto !== undefined) updateData.profilePhoto = body.profilePhoto;

      let user;
      
      // Try update by ID first
      try {
        user = await this.prisma.user.update({
          where: { id: userId },
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
      } catch {
        // If update fails (user doesn't exist), upsert by email
        if (email) {
          user = await this.prisma.user.upsert({
            where: { email },
            create: {
              email,
              supabaseId: String(userId),
              ...updateData,
              xp: 0,
              level: 1,
            },
            update: updateData,
            select: {
              id: true,
              email: true,
              name: true,
              phone: true,
              country: true,
              profilePhoto: true,
            },
          });
        } else {
          throw new Error('Cannot create user without email');
        }
      }
      
      console.log('Profile updated successfully:', user.id, 'Photo:', body.profilePhoto ? 'yes' : 'no');
      return { success: true, user };
    } catch (e) {
      console.error('Error updating profile:', e);
      return { error: 'Failed to update profile', details: e.message };
    }
  }

  @Post('notifications')
  async updateNotifications(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      telegramId?: string;
      telegramEnabled?: boolean;
      emailNotifications?: boolean;
      notifyOnTrade?: boolean;
      notifyOnBacktest?: boolean;
      notifyOnBalance?: boolean;
    }
  ) {
    const userId = this.getUserId(req);
    try {
      await this.prisma.user.update({
        where: { id: userId },
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
    @Body() body: { amount: number; reason: string }
  ) {
    const userId = this.getUserId(req);
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { xp: true, level: true },
      });
      
      if (!user) return { error: 'User not found' };
      
      const newXP = (user.xp || 0) + body.amount;
      // Level up every 1000 XP
      const newLevel = Math.floor(newXP / 1000) + 1;
      
      await this.prisma.user.update({
        where: { id: userId },
        data: { xp: newXP, level: newLevel },
      });
      
      return { 
        success: true, 
        xp: newXP, 
        level: newLevel,
        leveledUp: newLevel > user.level,
      };
    } catch (e) {
      console.error('Error adding XP:', e);
      return { error: 'Failed to add XP' };
    }
  }

  @Get('stats')
  async getUserStats(@Req() req: AuthenticatedRequest) {
    const userId = this.getUserId(req);
    try {
      const [user, strategiesCount, backtestsCount, tradesCount] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { xp: true, level: true, achievements: true, createdAt: true },
        }),
        this.prisma.strategy.count({ where: { userId } }),
        this.prisma.backtestResult.count({ where: { userId } }),
        this.prisma.trade.count({ where: { userId } }),
      ]);
      
      let achievements = [];
      try {
        achievements = user?.achievements ? JSON.parse(user.achievements) : [];
      } catch {}
      
      return {
        xp: user?.xp || 0,
        level: user?.level || 1,
        achievements,
        strategiesCreated: strategiesCount,
        backtestsRun: backtestsCount,
        tradesExecuted: tradesCount,
        memberSince: user?.createdAt,
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
      };
    }
  }
}

