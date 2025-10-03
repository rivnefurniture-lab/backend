// src/modules/payments/payments.controller.ts
import { Controller, Post, Body } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('pay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('stripe/create-session')
  stripe(@Body() body: { planId?: PlanId; redirect?: string }) {
    return this.payments.createStripeSession(body.planId, body.redirect);
  }

  @Post('liqpay/create')
  liqpay(@Body() body: { planId?: PlanId; redirect?: string }) {
    return this.payments.createLiqpay(body.planId, body.redirect);
  }

  @Post('crypto/create')
  crypto(@Body() body: { planId?: PlanId; redirect?: string }) {
    return this.payments.createCrypto(body.planId, body.redirect);
  }
}
