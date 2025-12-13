// src/modules/payments/payments.controller.ts
import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { PaymentsService } from './payments.service';

type PlanId = 'starter' | 'pro' | 'elite';

@Controller('pay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Get crypto payment details
  @Post('crypto/create')
  createCrypto(@Body() body: { planId?: PlanId; email?: string }) {
    return this.payments.createCryptoPayment(
      body.planId || 'starter',
      body.email,
    );
  }

  // Get plan details
  @Get('plans/:planId')
  getPlan(@Param('planId') planId: PlanId) {
    return this.payments.getPlanDetails(planId);
  }

  // Get all plans
  @Get('plans')
  getAllPlans() {
    return {
      plans: [
        this.payments.getPlanDetails('starter'),
        this.payments.getPlanDetails('pro'),
        this.payments.getPlanDetails('elite'),
      ],
    };
  }
}
