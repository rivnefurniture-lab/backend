import { Controller, Post, Get, Body, Query, UseGuards, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import { ExchangeService } from './exchange.service';
import { ConnectDto } from './connect.dto';
import { MarketOrderDto } from './order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

interface JwtUser {
  sub: number;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@UseGuards(JwtAuthGuard)
@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  private getUserId(req: AuthenticatedRequest): number {
    return req.user?.sub || 1;
  }

  @Post('connect')
  connect(@Req() req: AuthenticatedRequest, @Body() body: ConnectDto) {
    const userId = this.getUserId(req);
    const { exchange, apiKey, secret, password, testnet = true } = body;
    return this.exchange.connect(userId, exchange, {
      apiKey,
      secret,
      password,
      testnet,
    });
  }

  @Post('disconnect/:exchange')
  disconnect(@Req() req: AuthenticatedRequest, @Param('exchange') exchange: string) {
    const userId = this.getUserId(req);
    return this.exchange.disconnect(userId, exchange);
  }

  @Get('connections')
  getConnections(@Req() req: AuthenticatedRequest) {
    const userId = this.getUserId(req);
    return this.exchange.getUserConnections(userId);
  }

  @Get('balance')
  getBalance(@Req() req: AuthenticatedRequest, @Query('exchange') exchange: string) {
    const userId = this.getUserId(req);
    return this.exchange.getBalance(exchange, userId);
  }

  @Get('markets')
  getMarkets(@Req() req: AuthenticatedRequest, @Query('exchange') exchange: string) {
    const userId = this.getUserId(req);
    return this.exchange.getMarkets(exchange, userId);
  }

  @Post('order/market')
  createOrder(@Req() req: AuthenticatedRequest, @Body() body: MarketOrderDto) {
    const userId = this.getUserId(req);
    const { exchange, symbol, side, amountBase } = body;
    return this.exchange.createMarketOrder(exchange, symbol, side, amountBase, userId);
  }
}
