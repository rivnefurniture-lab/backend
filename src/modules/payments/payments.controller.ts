// src/modules/payments/payments.controller.ts
import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  HttpCode,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';

type PlanId = 'starter' | 'pro' | 'elite';

@Controller('pay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Payment endpoints - no auth required
  @Post('binance/create')
  createBinancePay(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createBinancePayOrder(body.planId || 'starter', body.email);
  }

  @Post('crypto/create')
  createCrypto(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createCryptoPayment(body.planId || 'starter', body.email);
  }

  // Webhook endpoint (no auth guard - called by payment providers)
  @Post('binance/webhook')
  @HttpCode(200)
  async binanceWebhook(
    @Headers('BinancePay-Timestamp') timestamp: string,
    @Headers('BinancePay-Nonce') nonce: string,
    @Headers('BinancePay-Signature') signature: string,
    @Req() req: any,
  ) {
    const body = JSON.stringify(req.body);

    if (!this.payments.verifyBinanceWebhook(timestamp, nonce, body, signature)) {
      return { returnCode: 'FAIL', returnMessage: 'Invalid signature' };
    }

    console.log('Binance Pay webhook received:', req.body);

    return { returnCode: 'SUCCESS', returnMessage: null };
  }
}
