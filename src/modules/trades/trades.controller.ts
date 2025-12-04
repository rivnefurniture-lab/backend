import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

interface JwtUser {
  sub: number;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('trades')
@UseGuards(JwtAuthGuard)
export class TradesController {
  constructor(private prisma: PrismaService) {}

  private getUserId(req: AuthenticatedRequest): number {
    return req.user?.sub || 1;
  }

  @Get()
  async getTrades(
    @Req() req: AuthenticatedRequest,
    @Query('filter') filter?: string,
    @Query('range') range?: string,
  ) {
    const userId = this.getUserId(req);
    
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

    return this.prisma.trade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('stats')
  async getStats(@Req() req: AuthenticatedRequest) {
    const userId = this.getUserId(req);
    
    const trades = await this.prisma.trade.findMany({
      where: { userId },
    });

    const totalTrades = trades.length;
    const totalProfit = trades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
    const winningTrades = trades.filter(t => (t.profitLoss || 0) > 0).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    return {
      totalTrades,
      totalProfit,
      winningTrades,
      winRate,
    };
  }
}

