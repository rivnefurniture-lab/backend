import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

interface JwtUser {
  sub: string; // Supabase uses UUID strings
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('trades')
@UseGuards(JwtAuthGuard)
export class TradesController {
  constructor(private prisma: PrismaService) {}

  // Resolve Supabase UUID to database user ID
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = req.user?.sub || '';
    const email = req.user?.email || '';
    
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
      }
      
      return user?.id || 1;
    } catch (e) {
      return 1;
    }
  }

  @Get()
  async getTrades(
    @Req() req: AuthenticatedRequest,
    @Query('filter') filter?: string,
    @Query('range') range?: string,
  ) {
    const userId = await this.getUserId(req);
    
    // Calculate date range
    let dateFrom: Date | undefined;
    const now = new Date();
    
    switch (range) {
      case '1d':
        dateFrom = new Date(now.setDate(now.getDate() - 1));
        break;
      case '7d':
        dateFrom = new Date(now.setDate(now.getDate() - 7));
        break;
      case '30d':
        dateFrom = new Date(now.setDate(now.getDate() - 30));
        break;
      default:
        // All time - no filter
        break;
    }

    // Build where clause
    const where: any = { userId };
    
    if (dateFrom) {
      where.createdAt = { gte: dateFrom };
    }
    
    if (filter && filter !== 'all') {
      switch (filter) {
        case 'buy':
          where.side = 'buy';
          break;
        case 'sell':
          where.side = 'sell';
          break;
        case 'profitable':
          where.profitLoss = { gt: 0 };
          break;
        case 'loss':
          where.profitLoss = { lt: 0 };
          break;
      }
    }

    try {
      return await this.prisma.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    } catch (e) {
      return [];
    }
  }

  @Get('stats')
  async getStats(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    
    try {
      // Get all trades
      const trades = await this.prisma.trade.findMany({
        where: { userId },
      });

      // Get today's trades
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const todayTrades = await this.prisma.trade.findMany({
        where: {
          userId,
          createdAt: { gte: todayStart },
        },
      });

      // Calculate stats - only count CLOSED trades for win rate (trades with exitPrice set)
      const closedTrades = trades.filter(t => t.exitPrice !== null);
      const openTrades = trades.filter(t => t.exitPrice === null && t.side === 'buy');
      
      const totalClosedTrades = closedTrades.length;
      const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
      const winningTrades = closedTrades.filter(t => (t.profitLoss || 0) > 0).length;
      const winRate = totalClosedTrades > 0 ? (winningTrades / totalClosedTrades) * 100 : 0;
      
      // Total trades = closed trades + open positions
      const totalTrades = totalClosedTrades + openTrades.length;

      // Calculate today's PnL
      const todayProfit = todayTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
      
      // Get total invested today (sum of entry values)
      const todayInvested = todayTrades.reduce((sum, t) => {
        if (t.side === 'buy' && t.entryPrice) {
          return sum + (t.entryPrice * t.quantity);
        }
        return sum;
      }, 0);
      
      // Calculate PnL percentage
      const todayPnLPercent = todayInvested > 0 ? (todayProfit / todayInvested) * 100 : 0;

      // Get yesterday's trades for comparison
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      
      const yesterdayTrades = await this.prisma.trade.findMany({
        where: {
          userId,
          createdAt: {
            gte: yesterdayStart,
            lt: todayStart,
          },
        },
      });
      
      const yesterdayProfit = yesterdayTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);

      return {
        totalTrades,
        totalProfit,
        winningTrades,
        winRate,
        todayTrades: todayTrades.length,
        todayProfit,
        todayPnLPercent,
        yesterdayProfit,
      };
    } catch (e) {
      console.error('Error getting trade stats:', e);
      return {
        totalTrades: 0,
        totalProfit: 0,
        winningTrades: 0,
        winRate: 0,
        todayTrades: 0,
        todayProfit: 0,
        todayPnLPercent: 0,
        yesterdayProfit: 0,
      };
    }
  }
}
