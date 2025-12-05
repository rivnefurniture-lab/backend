import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

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
  constructor(private readonly prisma: PrismaService) {}

  // Get the supabase UUID from JWT
  private getSupabaseId(req: AuthenticatedRequest): string {
    return req.user?.sub || '';
  }
  
  private getEmail(req: AuthenticatedRequest): string {
    return req.user?.email || '';
  }
  
  // Find or create user by supabaseId
  private async findOrCreateUser(supabaseId: string, email: string) {
    if (!supabaseId && !email) {
      throw new Error('No user identifier provided');
    }
    
    // First try to find by supabaseId
    let user = await this.prisma.user.findFirst({
      where: { supabaseId },
    });
    
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
          supabaseId,
          xp: 0,
          level: 1,
        },
      });
    }
    
    return user;
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
      if (body.profilePhoto !== undefined) updateData.profilePhoto = body.profilePhoto;

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
      
      console.log('Profile updated successfully:', user.id, 'Photo:', body.profilePhoto ? 'yes (length: ' + body.profilePhoto.length + ')' : 'no');
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
    @Body() body: { amount: number; reason: string }
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
        };
      }
      
      const [strategiesCount, backtestsCount, tradesCount] = await Promise.all([
        this.prisma.strategy.count({ where: { userId: user.id } }),
        this.prisma.backtestResult.count({ where: { userId: user.id } }),
        this.prisma.trade.count({ where: { userId: user.id } }),
      ]);
      
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
      };
    }
  }
}

