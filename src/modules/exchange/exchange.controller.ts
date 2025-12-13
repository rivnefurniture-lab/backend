import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Req,
  Param,
} from '@nestjs/common';
import type { Request } from 'express';
import { ExchangeService } from './exchange.service';
import { ConnectDto } from './connect.dto';
import { MarketOrderDto } from './order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

interface JwtUser {
  sub: string; // Supabase uses UUID strings
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@UseGuards(JwtAuthGuard)
@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly exchange: ExchangeService,
    private readonly prisma: PrismaService,
  ) {}

  // Resolve Supabase UUID to database user ID
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = req.user?.sub || '';
    const email = req.user?.email || '';

    try {
      // Find by supabaseId
      let user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: { id: true },
      });

      // Try by email
      if (!user && email) {
        user = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });

        // Update supabaseId if found by email
        if (user && supabaseId) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { supabaseId },
          });
        }
      }

      // Create if not found
      if (!user && email) {
        user = await this.prisma.user.create({
          data: {
            email,
            supabaseId,
            xp: 0,
            level: 1,
          },
          select: { id: true },
        });
      }

      return user?.id || 1;
    } catch (e) {
      console.error('Error resolving user ID:', e);
      return 1;
    }
  }

  @Post('connect')
  async connect(@Req() req: AuthenticatedRequest, @Body() body: ConnectDto) {
    const userId = await this.getUserId(req);
    const { exchange, apiKey, secret, password, testnet = true } = body;
    console.log(`Connecting ${exchange} for user ${userId}`);
    return this.exchange.connect(userId, exchange, {
      apiKey,
      secret,
      password,
      testnet,
    });
  }

  @Post('disconnect/:exchange')
  async disconnect(
    @Req() req: AuthenticatedRequest,
    @Param('exchange') exchange: string,
  ) {
    const userId = await this.getUserId(req);
    return this.exchange.disconnect(userId, exchange);
  }

  @Get('connections')
  async getConnections(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.exchange.getUserConnections(userId);
  }

  @Get('balance')
  async getBalance(
    @Req() req: AuthenticatedRequest,
    @Query('exchange') exchange: string,
  ) {
    const userId = await this.getUserId(req);
    return this.exchange.getBalance(exchange, userId);
  }

  @Get('markets')
  async getMarkets(
    @Req() req: AuthenticatedRequest,
    @Query('exchange') exchange: string,
  ) {
    const userId = await this.getUserId(req);
    return this.exchange.getMarkets(exchange, userId);
  }

  @Post('order/market')
  async createOrder(
    @Req() req: AuthenticatedRequest,
    @Body() body: MarketOrderDto,
  ) {
    const userId = await this.getUserId(req);
    const { exchange, symbol, side, amountBase } = body;
    return this.exchange.createMarketOrder(
      exchange,
      symbol,
      side,
      amountBase,
      userId,
    );
  }
}
