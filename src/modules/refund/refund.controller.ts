import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
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

@Controller('refund')
export class RefundController {
  constructor(private prisma: PrismaService) {}

  private getUserId(req: AuthenticatedRequest): number {
    return req.user?.sub || 1;
  }

  @UseGuards(JwtAuthGuard)
  @Post('request')
  async createRequest(
    @Req() req: AuthenticatedRequest,
    @Body() body: { reason: string },
  ) {
    const userId = this.getUserId(req);
    
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
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  async getMyRequests(@Req() req: AuthenticatedRequest) {
    const userId = this.getUserId(req);
    
    return this.prisma.refundRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

