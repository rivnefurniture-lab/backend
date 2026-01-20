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

  // Exchange rate for UAH
  private readonly USD_TO_UAH = 41;

  // ==================== LIQPAY ====================
  /**
   * Create LiqPay payment
   * Official docs: https://www.liqpay.ua/documentation/api/aquiring/checkout/doc
   */
  async createLiqPayPayment(
    planId: PlanId = 'pro',
    billing: Billing = 'monthly',
    userEmail?: string,
    currency: 'USD' | 'UAH' = 'USD',
    productName?: string,
    productDescription?: string,
  ) {
    const priceConfig = this.PRICE_MAP[planId];
    const amountUSD = billing === 'yearly' ? priceConfig.yearly : priceConfig.monthly;

    if (amountUSD === 0) {
      throw new Error('Cannot create payment for free plan');
    }

    // Calculate amount in selected currency
    const amount = currency === 'UAH' ? Math.round(amountUSD * this.USD_TO_UAH) : amountUSD;

    // Generate unique order_id
    const orderId = `algotcha_${planId}_${billing}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Service names for compliance
    const serviceNames: Record<PlanId, { uk: string; en: string }> = {
      free: { 
        uk: 'Algotcha Free - Базовий доступ до SaaS платформи', 
        en: 'Algotcha Free - Basic SaaS Platform Access' 
      },
      pro: { 
        uk: 'Algotcha Pro - Професійна підписка на SaaS платформу бектестування', 
        en: 'Algotcha Pro - Professional Backtesting SaaS Platform Subscription' 
      },
      enterprise: { 
        uk: 'Algotcha Enterprise - Корпоративна підписка на SaaS платформу', 
        en: 'Algotcha Enterprise - Corporate SaaS Platform Subscription' 
      },
    };

    const serviceDescriptions: Record<PlanId, { uk: string; en: string }> = {
      free: {
        uk: 'Безкоштовний план для ознайомлення з платформою бектестування',
        en: 'Free plan to explore the backtesting platform',
      },
      pro: {
        uk: 'Професійний план з необмеженим доступом до бектестування, всіх технічних індикаторів та 5 років історичних даних',
        en: 'Professional plan with unlimited backtesting, all technical indicators, and 5 years of historical data',
      },
      enterprise: {
        uk: 'Корпоративний план з виділеним сервером, API доступом та персональним менеджером',
        en: 'Corporate plan with dedicated server, API access, and personal account manager',
      },
    };

    // LiqPay payment parameters
    const params = {
      public_key: this.LIQPAY_PUBLIC_KEY,
      version: '3',
      action: 'pay',
      amount: amount,
      currency: currency,
      description: productName || serviceNames[planId].uk, // Use Ukrainian for LiqPay
      order_id: orderId,
      result_url: `${this.FRONTEND_URL}/pay-success?plan=${planId}&billing=${billing}`,
      server_url: `${process.env.BACKEND_URL || 'https://algotcha-api-prod.up.railway.app'}/pay/liqpay/callback`,
      language: 'uk', // Default to Ukrainian per LiqPay requirements
      ...(userEmail && { customer_email: userEmail }),
      // Additional parameters for compliance
      product_name: productName || serviceNames[planId].uk,
      product_category: 'software',
      product_description: productDescription || serviceDescriptions[planId].uk,
      expired_date: this.formatLiqPayDate(new Date(Date.now() + 24 * 60 * 60 * 1000)), // 24 hours expiry in LiqPay format
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
      currency,
      amountUSD, // Original USD amount for reference
      data,
      signature,
      // Alternative: return HTML form for embedded checkout
      formHtml: this.generateLiqPayForm(data, signature),
    };
  }

  /**
   * Format date for LiqPay (YYYY-MM-DD HH:MM:SS)
   */
  private formatLiqPayDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
