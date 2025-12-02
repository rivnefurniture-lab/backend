// src/modules/payments/payments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

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

  // ==================== WAYFORPAY ====================
  private generateWayForPaySignature(params: string[]): string {
    const secretKey = process.env.WAYFORPAY_SECRET_KEY;
    if (!secretKey) throw new BadRequestException('WayForPay not configured');

    const signString = params.join(';');
    return crypto.createHmac('md5', secretKey).update(signString).digest('hex');
  }

  async createWayForPayOrder(planId: PlanId = 'starter', userId?: string) {
    const merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
    const merchantDomain = process.env.WAYFORPAY_MERCHANT_DOMAIN;

    if (!merchantAccount || !merchantDomain) {
      throw new BadRequestException('WayForPay not configured');
    }

    const amount = this.PRICE_MAP[planId];
    const orderReference = `ALG${Date.now()}`;
    const orderDate = Math.floor(Date.now() / 1000);
    const productName = `Algotcha ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`;
    const productCount = 1;
    const productPrice = amount;

    // Signature string: merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;productName;productCount;productPrice
    const signatureParams = [
      merchantAccount,
      merchantDomain,
      orderReference,
      orderDate.toString(),
      amount.toString(),
      'USD',
      productName,
      productCount.toString(),
      productPrice.toString(),
    ];

    const merchantSignature = this.generateWayForPaySignature(signatureParams);

    // Build form data for redirect
    const formData = {
      merchantAccount,
      merchantDomainName: merchantDomain,
      merchantTransactionSecureType: 'AUTO',
      merchantSignature,
      orderReference,
      orderDate,
      amount,
      currency: 'USD',
      productName: [productName],
      productCount: [productCount],
      productPrice: [productPrice],
      returnUrl: `${this.FRONTEND_URL}/pay-success?plan=${planId}`,
      serviceUrl: `${process.env.BACKEND_URL || 'http://localhost:8080'}/pay/wayforpay/webhook`,
      language: 'EN',
    };

    return {
      provider: 'wayforpay',
      formAction: 'https://secure.wayforpay.com/pay',
      formData,
      orderId: orderReference,
    };
  }

  // ==================== DIRECT CRYPTO (Manual) ====================
  async createCryptoPayment(planId: PlanId = 'starter') {
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

  verifyWayForPayWebhook(body: any): boolean {
    const secretKey = process.env.WAYFORPAY_SECRET_KEY;
    if (!secretKey) return false;

    const signatureParams = [
      body.merchantAccount,
      body.orderReference,
      body.amount,
      body.currency,
      body.authCode,
      body.cardPan,
      body.transactionStatus,
      body.reasonCode,
    ];

    const expectedSignature = this.generateWayForPaySignature(signatureParams);
    return body.merchantSignature === expectedSignature;
  }
}
