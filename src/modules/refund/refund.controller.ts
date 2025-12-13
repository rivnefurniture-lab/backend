import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
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

@Controller('refund')
export class RefundController {
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

  @UseGuards(JwtAuthGuard)
  @Post('request')
  async createRequest(
    @Req() req: AuthenticatedRequest,
    @Body() body: { reason: string },
  ) {
    const userId = await this.getUserId(req);

    try {
      // Get user email
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      if (!user) {
        return { error: 'User not found' };
      }

      // Create refund request
      const refund = await this.prisma.refundRequest.create({
        data: {
          userId,
          email: user.email,
          reason: body.reason,
          amount: 0, // Will be determined by admin
          status: 'pending',
        },
      });

      // TODO: Send email notification to admin
      console.log(`New refund request from ${user.email}: ${body.reason}`);

      return {
        ok: true,
        message: 'Refund request submitted successfully',
        id: refund.id,
      };
    } catch (e) {
      console.error('Error creating refund request:', e);
      return { error: 'Failed to create refund request' };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  async getMyRequests(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);

    try {
      return await this.prisma.refundRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
    } catch (e) {
      return [];
    }
  }
}
