// src/modules/payments/payments.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  Headers,
  Req,
  HttpCode,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import type { Request } from 'express';

type PlanId = 'starter' | 'pro' | 'elite';

@Controller('pay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('binance/create')
  createBinancePay(@Body() body: { planId?: PlanId }) {
    return this.payments.createBinancePayOrder(body.planId || 'starter');
  }

  @UseGuards(JwtAuthGuard)
  @Post('wayforpay/create')
  createWayForPay(@Body() body: { planId?: PlanId }) {
    return this.payments.createWayForPayOrder(body.planId || 'starter');
  }

  @UseGuards(JwtAuthGuard)
  @Post('crypto/create')
  createCrypto(@Body() body: { planId?: PlanId }) {
    return this.payments.createCryptoPayment(body.planId || 'starter');
  }

  // Webhook endpoints (no auth guard - called by payment providers)
  @Post('binance/webhook')
  @HttpCode(200)
  async binanceWebhook(
    @Headers('BinancePay-Timestamp') timestamp: string,
    @Headers('BinancePay-Nonce') nonce: string,
    @Headers('BinancePay-Signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const body = req.rawBody?.toString() || '';

    if (!this.payments.verifyBinanceWebhook(timestamp, nonce, body, signature)) {
      return { returnCode: 'FAIL', returnMessage: 'Invalid signature' };
    }

    const data = JSON.parse(body);
    // TODO: Update user subscription status in database
    console.log('Binance Pay webhook received:', data);

    return { returnCode: 'SUCCESS', returnMessage: null };
  }

  @Post('wayforpay/webhook')
  @HttpCode(200)
  async wayforpayWebhook(@Body() body: any) {
    if (!this.payments.verifyWayForPayWebhook(body)) {
      return {
        orderReference: body.orderReference,
        status: 'decline',
        time: Math.floor(Date.now() / 1000),
        signature: '',
      };
    }

    // TODO: Update user subscription status in database
    console.log('WayForPay webhook received:', body);

    // Response signature
    const responseTime = Math.floor(Date.now() / 1000);
    return {
      orderReference: body.orderReference,
      status: 'accept',
      time: responseTime,
      signature: '', // TODO: Generate proper response signature
    };
  }
}
