import { Controller, Post, Get, Body, Query, UseGuards } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { ConnectDto } from './connect.dto';
import { MarketOrderDto } from './order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  @Post('connect')
  connect(@Body() body: ConnectDto) {
    const { exchange, apiKey, secret, password, testnet = true } = body;
    return this.exchange.connect(exchange, {
      apiKey,
      secret,
      password,
      testnet,
    });
  }

  @Get('balance')
  getBalance(@Query('exchange') exchange: string) {
    return this.exchange.getBalance(exchange);
  }

  @Get('markets')
  getMarkets(@Query('exchange') exchange: string) {
    return this.exchange.getMarkets(exchange);
  }

  @Post('order/market')
  createOrder(@Body() body: MarketOrderDto) {
    const { exchange, symbol, side, amountBase } = body;
    return this.exchange.createMarketOrder(exchange, symbol, side, amountBase);
  }
}
