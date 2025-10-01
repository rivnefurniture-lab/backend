// src/modules/payments/payments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import * as crypto from 'crypto';

type PlanId = 'starter' | 'pro' | 'elite';

type CoinbaseChargeResponse = {
  data?: {
    hosted_url?: string;
    [key: string]: unknown;
  };
};

@Injectable()
export class PaymentsService {
  private readonly STRIPE = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2025-08-27.basil',
      })
    : null;

  private readonly FRONTEND_URL =
    process.env.FRONTEND_URL || 'http://localhost:5173';

  private readonly PRICE_MAP: Record<string, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    elite: process.env.STRIPE_PRICE_ELITE,
  };

  async createStripeSession(planId: PlanId = 'starter', redirect = '/') {
    if (!this.STRIPE) throw new BadRequestException('Stripe not configured');
    const price = this.PRICE_MAP[planId];
    if (!price)
      throw new BadRequestException('Stripe price id not set for plan');

    const session = await this.STRIPE.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${this.FRONTEND_URL}/pay/success?plan=${planId}&redirect=${encodeURIComponent(
        redirect,
      )}`,
      cancel_url: `${this.FRONTEND_URL}/pay/cancel`,
    });

    return { url: session.url };
  }

  createLiqpay(planId: PlanId = 'starter', redirect = '/') {
    const pub = process.env.LIQPAY_PUBLIC_KEY;
    const priv = process.env.LIQPAY_PRIVATE_KEY;
    if (!pub || !priv) throw new BadRequestException('LiqPay not configured');

    const amountMap: Record<PlanId, number> = {
      starter: 9,
      pro: 29,
      elite: 79,
    };

    const payload = {
      public_key: pub,
      version: 3,
      action: 'pay',
      amount: amountMap[planId] || 9,
      currency: 'USD',
      description: `algotcha ${planId} subscription`,
      result_url: `${this.FRONTEND_URL}/pay/success?plan=${planId}&redirect=${encodeURIComponent(
        redirect,
      )}`,
      server_url: `${this.FRONTEND_URL}/pay/success?plan=${planId}&redirect=${encodeURIComponent(
        redirect,
      )}`,
    };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = crypto
      .createHash('sha1')
      .update(priv + data + priv)
      .digest('base64');

    return { url: 'https://www.liqpay.ua/api/3/checkout', data, signature };
  }

  async createCrypto(planId: PlanId = 'starter', redirect = '/') {
    const amountMap = { starter: 9, pro: 29, elite: 79 };
    const apiKey = process.env.COINBASE_COMMERCE_API_KEY;

    if (!apiKey) {
      return {
        address: 'bc1qexampleexampleexample',
        amount: amountMap[planId] || 9,
        currency: 'USD',
      };
    }

    const resp = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `algotcha ${planId}`,
        description: 'Subscription payment',
        pricing_type: 'fixed_price',
        local_price: {
          amount: String(amountMap[planId] || 9),
          currency: 'USD',
        },
        metadata: { planId, redirect },
        redirect_url: `${this.FRONTEND_URL}/pay/success?plan=${planId}&redirect=${encodeURIComponent(
          redirect,
        )}`,
        cancel_url: `${this.FRONTEND_URL}/pay/cancel`,
      }),
    });
    const data = (await resp.json()) as CoinbaseChargeResponse;
    const url = data?.data?.hosted_url;
    if (!url) throw new BadRequestException('Coinbase Commerce error');

    return { url };
  }
}
