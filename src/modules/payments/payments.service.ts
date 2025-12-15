// src/modules/payments/payments.service.ts
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

type PlanId = 'free' | 'pro' | 'enterprise';
type Billing = 'monthly' | 'yearly';

@Injectable()
export class PaymentsService {
  private readonly FRONTEND_URL =
    process.env.FRONTEND_URL || 'https://algotcha.com';

  private readonly LIQPAY_PUBLIC_KEY = process.env.LIQPAY_PUBLIC_KEY || '';
  private readonly LIQPAY_PRIVATE_KEY = process.env.LIQPAY_PRIVATE_KEY || '';

  private readonly PRICE_MAP: Record<PlanId, { monthly: number; yearly: number }> = {
    free: { monthly: 0, yearly: 0 },
    pro: { monthly: 29, yearly: 23 },
    enterprise: { monthly: 99, yearly: 79 },
  };

  // ==================== LIQPAY ====================
  /**
   * Create LiqPay payment
   * Official docs: https://www.liqpay.ua/documentation/api/aquiring/checkout/doc
   */
  async createLiqPayPayment(
    planId: PlanId = 'pro',
    billing: Billing = 'monthly',
    userEmail?: string,
  ) {
    const priceConfig = this.PRICE_MAP[planId];
    const amount = billing === 'yearly' ? priceConfig.yearly : priceConfig.monthly;

    if (amount === 0) {
      throw new Error('Cannot create payment for free plan');
    }

    // Generate unique order_id
    const orderId = `algotcha_${planId}_${billing}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // LiqPay payment parameters
    const params = {
      public_key: this.LIQPAY_PUBLIC_KEY,
      version: '3',
      action: 'pay',
      amount: amount,
      currency: 'USD',
      description: `Algotcha ${planId.toUpperCase()} - ${billing === 'yearly' ? 'Annual' : 'Monthly'} Subscription`,
      order_id: orderId,
      result_url: `${this.FRONTEND_URL}/pay-success?plan=${planId}&billing=${billing}`,
      server_url: `${process.env.BACKEND_URL || 'https://algotcha-api-prod.up.railway.app'}/pay/liqpay/callback`,
      language: 'uk', // Default to Ukrainian per LiqPay requirements
      ...(userEmail && { customer_email: userEmail }),
      // Additional parameters
      product_name: `Algotcha ${planId.toUpperCase()}`,
      product_category: 'software',
      product_description: `Trading strategy backtest platform subscription`,
      expired_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours expiry
    };

    // Generate signature
    const data = Buffer.from(JSON.stringify(params)).toString('base64');
    const signature = this.generateLiqPaySignature(data);

    // LiqPay checkout URL
    const checkoutUrl = `https://www.liqpay.ua/api/3/checkout?data=${encodeURIComponent(data)}&signature=${signature}`;

    return {
      provider: 'liqpay',
      checkoutUrl,
      orderId,
      amount,
      currency: 'USD',
      data,
      signature,
      // Alternative: return HTML form for embedded checkout
      formHtml: this.generateLiqPayForm(data, signature),
    };
  }

  /**
   * Generate LiqPay signature
   * Formula: base64_encode(sha1(private_key + data + private_key))
   */
  private generateLiqPaySignature(data: string): string {
    const signString = this.LIQPAY_PRIVATE_KEY + data + this.LIQPAY_PRIVATE_KEY;
    return crypto.createHash('sha1').update(signString).digest('base64');
  }

  /**
   * Generate LiqPay HTML form for embedded checkout
   */
  private generateLiqPayForm(data: string, signature: string): string {
    return `
      <form method="POST" action="https://www.liqpay.ua/api/3/checkout" accept-charset="utf-8">
        <input type="hidden" name="data" value="${data}" />
        <input type="hidden" name="signature" value="${signature}" />
      </form>
    `;
  }

  /**
   * Verify LiqPay callback signature
   */
  verifyLiqPayCallback(data: string, signature: string): boolean {
    const expectedSignature = this.generateLiqPaySignature(data);
    return signature === expectedSignature;
  }

  /**
   * Decode LiqPay callback data
   */
  decodeLiqPayData(data: string): any {
    try {
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch (e) {
      throw new Error('Invalid LiqPay data');
    }
  }

  // Get plan details
  getPlanDetails(planId: PlanId) {
    const plans = {
      free: {
        name: 'Free',
        priceMonthly: 0,
        priceYearly: 0,
        features: [
          '3 Backtests per day',
          '1 Active Strategy',
          'Basic Indicators',
          'Community Support',
        ],
      },
      pro: {
        name: 'Pro',
        priceMonthly: 29,
        priceYearly: 23,
        features: [
          'Unlimited Backtests',
          '5 Active Strategies',
          'All 20+ Indicators',
          'Priority Support',
          'Report Exports',
          'Telegram/Email Alerts',
        ],
      },
      enterprise: {
        name: 'Enterprise',
        priceMonthly: 99,
        priceYearly: 79,
        features: [
          'Everything in Pro',
          'Unlimited Strategies',
          'Dedicated Server',
          'Personal Manager',
          'API Access',
          'White-label Options',
        ],
      },
    };

    return plans[planId] || plans.pro;
  }
}
