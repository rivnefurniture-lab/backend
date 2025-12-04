// src/modules/payments/payments.controller.ts
import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  HttpCode,
  RawBodyRequest,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import type { Request } from 'express';

type PlanId = 'starter' | 'pro' | 'elite';

@Controller('pay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Payment endpoints - no auth required (payment itself is the auth)
  @Post('binance/create')
  createBinancePay(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createBinancePayOrder(body.planId || 'starter', body.email);
  }

  @Post('stripe/create')
  createStripe(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createStripeCheckout(body.planId || 'starter', body.email);
  }

  @Post('crypto/create')
  createCrypto(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createCryptoPayment(body.planId || 'starter', body.email);
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

  @Post('stripe/webhook')
  @HttpCode(200)
  async stripeWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const payload = req.rawBody;
    if (!payload) {
      return { error: 'No payload' };
    }

    const event = await this.payments.verifyStripeWebhook(payload, signature);
    if (!event) {
      return { error: 'Invalid signature' };
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('Stripe checkout completed:', session);
        // TODO: Update user subscription status in database
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        console.log('Stripe subscription updated:', event.data.object);
        break;
      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    return { received: true };
  }
}
