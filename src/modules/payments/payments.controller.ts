// src/modules/payments/payments.controller.ts
import { Controller, Post, Get, Body, Param, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import type { Request, Response } from 'express';

type PlanId = 'free' | 'pro' | 'enterprise';
type Billing = 'monthly' | 'yearly';

interface LiqPayCreateBody {
  planId?: PlanId;
  billing?: Billing;
  email?: string;
  amount?: number;
}

interface LiqPayCallbackBody {
  data: string;
  signature: string;
}

@Controller('pay')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  // ==================== LIQPAY ====================
  
  /**
   * Create LiqPay payment
   * POST /pay/liqpay/create
   */
  @Post('liqpay/create')
  async createLiqPay(@Body() body: LiqPayCreateBody) {
    try {
      this.logger.log(`Creating LiqPay payment for plan: ${body.planId}, billing: ${body.billing}`);
      
      return await this.payments.createLiqPayPayment(
        body.planId || 'pro',
        body.billing || 'monthly',
        body.email,
      );
    } catch (error) {
      this.logger.error(`Failed to create LiqPay payment: ${error.message}`);
      throw error;
    }
  }

  /**
   * LiqPay callback endpoint
   * POST /pay/liqpay/callback
   * 
   * LiqPay will send payment status updates here
   */
  @Post('liqpay/callback')
  async liqpayCallback(
    @Body() body: LiqPayCallbackBody,
    @Res() res: Response,
  ) {
    try {
      const { data, signature } = body;

      // Verify signature
      const isValid = this.payments.verifyLiqPayCallback(data, signature);
      if (!isValid) {
        this.logger.error('Invalid LiqPay signature');
        return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Invalid signature' });
      }

      // Decode payment data
      const paymentData = this.payments.decodeLiqPayData(data);
      
      this.logger.log(`LiqPay callback received: ${JSON.stringify(paymentData)}`);

      // Check payment status
      const { status, order_id, amount, currency, transaction_id } = paymentData;

      if (status === 'success') {
        // Payment successful - activate subscription
        this.logger.log(`Payment successful: Order ${order_id}, Amount: ${amount} ${currency}, TxID: ${transaction_id}`);
        
        // TODO: Update user subscription in database
        // Extract plan and billing from order_id (format: algotcha_pro_monthly_timestamp_random)
        const parts = order_id.split('_');
        if (parts.length >= 3) {
          const planId = parts[1];
          const billing = parts[2];
          const userEmail = paymentData.customer_email;
          
          this.logger.log(`Activating ${planId} ${billing} subscription for ${userEmail}`);
          
          // TODO: Implement subscription activation logic
          // Example:
          // await this.userService.activateSubscription(userEmail, planId, billing);
        }
      } else if (status === 'failure') {
        this.logger.warn(`Payment failed: Order ${order_id}`);
      } else if (status === 'sandbox') {
        this.logger.log(`Sandbox payment: Order ${order_id}`);
        // In sandbox mode, treat as success for testing
      } else {
        this.logger.warn(`Unknown payment status: ${status} for order ${order_id}`);
      }

      return res.status(HttpStatus.OK).json({ ok: true });
    } catch (error) {
      this.logger.error(`LiqPay callback error: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
    }
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
        this.payments.getPlanDetails('free'),
        this.payments.getPlanDetails('pro'),
        this.payments.getPlanDetails('enterprise'),
      ],
    };
  }
}
