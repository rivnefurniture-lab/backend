// src/modules/payments/payments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import Stripe from 'stripe';

type PlanId = 'starter' | 'pro' | 'elite';

interface BinancePayResponse {
  status: string;
  code: string;
  data?: {
    prepayId?: string;
    terminalType?: string;
    expireTime?: number;
    qrcodeLink?: string;
    qrContent?: string;
    checkoutUrl?: string;
    deeplink?: string;
    universalUrl?: string;
  };
  errorMessage?: string;
}

@Injectable()
export class PaymentsService {
  private readonly FRONTEND_URL =
    process.env.FRONTEND_URL || 'http://localhost:3000';

  private readonly PRICE_MAP: Record<PlanId, number> = {
    starter: 9,
    pro: 29,
    elite: 79,
  };

  private readonly STRIPE_PRICE_IDS: Record<PlanId, string> = {
    starter: process.env.STRIPE_PRICE_STARTER || '',
    pro: process.env.STRIPE_PRICE_PRO || '',
    elite: process.env.STRIPE_PRICE_ELITE || '',
  };

  private stripe: Stripe | null = null;

  constructor() {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2025-05-28.basil' });
    }
  }

  // ==================== BINANCE PAY ====================
  private generateBinanceSignature(
    timestamp: string,
    nonce: string,
    body: string,
  ): string {
    const secretKey = process.env.BINANCE_PAY_SECRET_KEY;
    if (!secretKey) throw new BadRequestException('Binance Pay not configured');

    const payload = `${timestamp}\n${nonce}\n${body}\n`;
    return crypto
      .createHmac('sha512', secretKey)
      .update(payload)
      .digest('hex')
      .toUpperCase();
  }

  async createBinancePayOrder(planId: PlanId = 'starter', userId?: string) {
    const apiKey = process.env.BINANCE_PAY_API_KEY;
    const merchantId = process.env.BINANCE_PAY_MERCHANT_ID;

    if (!apiKey || !merchantId) {
      throw new BadRequestException('Binance Pay not configured');
    }

    const amount = this.PRICE_MAP[planId];
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const merchantTradeNo = `ALG${Date.now()}${Math.random().toString(36).substring(7)}`;

    const requestBody = {
      env: {
        terminalType: 'WEB',
      },
      merchantTradeNo,
      orderAmount: amount.toFixed(2),
      currency: 'USDT',
      description: `Algotcha ${planId} subscription`,
      goodsDetails: [
        {
          goodsType: '02', // Virtual goods
          goodsCategory: 'Z000', // Others
          referenceGoodsId: planId,
          goodsName: `Algotcha ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
          goodsDetail: `Monthly subscription to Algotcha ${planId} trading strategies`,
          goodsUnitAmount: { currency: 'USDT', amount: amount.toFixed(2) },
          goodsQuantity: '1',
        },
      ],
      returnUrl: `${this.FRONTEND_URL}/pay-success?plan=${planId}`,
      cancelUrl: `${this.FRONTEND_URL}/pay-cancel`,
      webhookUrl: `${process.env.BACKEND_URL || 'http://localhost:8080'}/pay/binance/webhook`,
      orderExpireTime: Date.now() + 3600000, // 1 hour
    };

    const bodyString = JSON.stringify(requestBody);
    const signature = this.generateBinanceSignature(timestamp, nonce, bodyString);

    const response = await fetch(
      'https://bpay.binanceapi.com/binancepay/openapi/v2/order',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'BinancePay-Timestamp': timestamp,
          'BinancePay-Nonce': nonce,
          'BinancePay-Certificate-SN': apiKey,
          'BinancePay-Signature': signature,
        },
        body: bodyString,
      },
    );

    const data = (await response.json()) as BinancePayResponse;

    if (data.status !== 'SUCCESS') {
      throw new BadRequestException(
        data.errorMessage || 'Binance Pay order creation failed',
      );
    }

    return {
      provider: 'binance',
      checkoutUrl: data.data?.checkoutUrl,
      qrCode: data.data?.qrcodeLink,
      universalUrl: data.data?.universalUrl,
      orderId: merchantTradeNo,
      expireTime: data.data?.expireTime,
    };
  }

  // ==================== STRIPE ====================
  async createStripeCheckout(planId: PlanId = 'starter', userEmail?: string) {
    if (!this.stripe) {
      return {
        provider: 'stripe',
        error: 'Stripe not configured. Please add STRIPE_SECRET_KEY environment variable.',
        configured: false,
      };
    }

    const amount = this.PRICE_MAP[planId];
    const priceId = this.STRIPE_PRICE_IDS[planId];

    try {
      // If we have a price ID (recurring subscription), use it
      if (priceId) {
        const session = await this.stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${this.FRONTEND_URL}/pay-success?plan=${planId}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.FRONTEND_URL}/pay-cancel`,
          customer_email: userEmail || undefined,
          metadata: { planId },
        });

        return {
          provider: 'stripe',
          checkoutUrl: session.url,
          sessionId: session.id,
        };
      }

      // Otherwise create a one-time payment
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `Algotcha ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
                description: `Monthly subscription to Algotcha ${planId} trading strategies`,
              },
              unit_amount: amount * 100, // Stripe uses cents
            },
            quantity: 1,
          },
        ],
        success_url: `${this.FRONTEND_URL}/pay-success?plan=${planId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.FRONTEND_URL}/pay-cancel`,
        customer_email: userEmail || undefined,
        metadata: { planId },
      });

      return {
        provider: 'stripe',
        checkoutUrl: session.url,
        sessionId: session.id,
      };
    } catch (error) {
      throw new BadRequestException(`Stripe error: ${error.message}`);
    }
  }

  // ==================== DIRECT CRYPTO (Manual) ====================
  async createCryptoPayment(planId: PlanId = 'starter', userEmail?: string) {
    const amount = this.PRICE_MAP[planId];
    const walletAddress = process.env.CRYPTO_WALLET_ADDRESS;

    if (!walletAddress) {
      // Return demo wallet for testing
      return {
        provider: 'crypto',
        walletAddress: 'YOUR_USDT_TRC20_ADDRESS',
        amount,
        currency: 'USDT',
        network: 'TRC20',
        note: 'Send exact amount and contact support with transaction hash',
      };
    }

    return {
      provider: 'crypto',
      walletAddress,
      amount,
      currency: 'USDT',
      network: process.env.CRYPTO_NETWORK || 'TRC20',
      note: 'Send exact amount and contact support with transaction hash',
    };
  }

  // ==================== WEBHOOKS ====================
  verifyBinanceWebhook(
    timestamp: string,
    nonce: string,
    body: string,
    signature: string,
  ): boolean {
    const expectedSignature = this.generateBinanceSignature(
      timestamp,
      nonce,
      body,
    );
    return signature === expectedSignature;
  }

  async verifyStripeWebhook(payload: Buffer, signature: string): Promise<Stripe.Event | null> {
    if (!this.stripe) return null;
    
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!endpointSecret) return null;

    try {
      return this.stripe.webhooks.constructEvent(payload, signature, endpointSecret);
    } catch {
      return null;
    }
  }
}
