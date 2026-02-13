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
  // Cache for userId resolution
  private userIdCache: Map<string, { id: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private prisma: PrismaService) {}

  // Resolve Supabase UUID to database user ID (with caching)
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = req.user?.sub || '';
    const email = req.user?.email || '';

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
      }

      const userId = user?.id || 1;
      if (supabaseId && userId !== 1) {
        this.userIdCache.set(supabaseId, { id: userId, timestamp: Date.now() });
      }
      return userId;
    } catch (e) {
      if (cached) return cached.id;
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
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);

      const closedWhere = { userId, exitPrice: { not: null } };
      const openWhere = { userId, exitPrice: null, side: 'buy' };
      const todayWhere = { userId, createdAt: { gte: todayStart } };
      const yesterdayWhere = {
        userId,
        createdAt: { gte: yesterdayStart, lt: todayStart },
      };

      // Use aggregates/counts instead of loading all trades into memory
      const [
        closedAgg,
        winningCount,
        openCount,
        todayTrades,
        todayAgg,
        yesterdayAgg,
      ] = await Promise.all([
        this.prisma.trade.aggregate({
          where: closedWhere,
          _sum: { profitLoss: true },
          _count: true,
        }),
        this.prisma.trade.count({
          where: { ...closedWhere, profitLoss: { gt: 0 } },
        }),
        this.prisma.trade.count({ where: openWhere }),
        this.prisma.trade.findMany({
          where: todayWhere,
          select: {
            profitLoss: true,
            side: true,
            entryPrice: true,
            quantity: true,
          },
        }),
        this.prisma.trade.aggregate({
          where: todayWhere,
          _sum: { profitLoss: true },
        }),
        this.prisma.trade.aggregate({
          where: yesterdayWhere,
          _sum: { profitLoss: true },
        }),
      ]);

      const totalClosedTrades = closedAgg._count;
      const totalProfit = closedAgg._sum.profitLoss ?? 0;
      const winningTrades = winningCount;
      const winRate =
        totalClosedTrades > 0 ? (winningTrades / totalClosedTrades) * 100 : 0;
      const totalTrades = totalClosedTrades + openCount;

      const todayProfit = todayAgg._sum.profitLoss ?? 0;
      const todayInvested = todayTrades.reduce((sum, t) => {
        if (t.side === 'buy' && t.entryPrice) {
          return sum + t.entryPrice * t.quantity;
        }
        return sum;
      }, 0);
      const todayPnLPercent =
        todayInvested > 0 ? (todayProfit / todayInvested) * 100 : 0;
      const yesterdayProfit = yesterdayAgg._sum.profitLoss ?? 0;

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
