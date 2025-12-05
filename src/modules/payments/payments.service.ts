// src/modules/payments/payments.service.ts
import { Injectable } from '@nestjs/common';

type PlanId = 'starter' | 'pro' | 'elite';

@Injectable()
export class PaymentsService {
  private readonly FRONTEND_URL =
    process.env.FRONTEND_URL || 'http://localhost:3000';

  private readonly PRICE_MAP: Record<PlanId, number> = {
    starter: 9,
    pro: 29,
    elite: 79,
  };

  // ==================== DIRECT CRYPTO (Manual) ====================
  // This is the simplest approach - user sends crypto to your wallet
  // You manually verify and activate their subscription
  async createCryptoPayment(planId: PlanId = 'starter', userEmail?: string) {
    const amount = this.PRICE_MAP[planId];
    const walletAddressUSDT = process.env.CRYPTO_WALLET_USDT;
    const walletAddressBTC = process.env.CRYPTO_WALLET_BTC;
    const walletAddressETH = process.env.CRYPTO_WALLET_ETH;

    return {
      provider: 'crypto',
      plan: planId,
      amount,
      options: [
        {
          currency: 'USDT',
          network: 'TRC20',
          address: walletAddressUSDT || 'Contact support for address',
          amount: amount.toFixed(2),
        },
        {
          currency: 'USDT',
          network: 'ERC20',
          address: walletAddressETH || 'Contact support for address',
          amount: amount.toFixed(2),
        },
        {
          currency: 'BTC',
          network: 'Bitcoin',
          address: walletAddressBTC || 'Contact support for address',
          amount: (amount / 100000).toFixed(8), // Approximate BTC conversion
          note: 'BTC amount may vary based on current rate',
        },
        {
          currency: 'ETH',
          network: 'Ethereum',
          address: walletAddressETH || 'Contact support for address',
          amount: (amount / 4000).toFixed(6), // Approximate ETH conversion
          note: 'ETH amount may vary based on current rate',
        },
      ],
      instructions: [
        '1. Choose your preferred cryptocurrency',
        '2. Send the exact amount to the provided address',
        '3. Save the transaction hash',
        '4. Email support@algotcha.com with your transaction hash and email',
        '5. Your subscription will be activated within 24 hours',
      ],
      supportEmail: 'support@algotcha.com',
      returnUrl: `${this.FRONTEND_URL}/pay-success?plan=${planId}`,
    };
  }

  // Get plan details
  getPlanDetails(planId: PlanId) {
    const plans = {
      starter: {
        name: 'Starter',
        price: 9,
        features: [
          '5 Strategy Backtests/month',
          '1 Live Trading Strategy',
          'Basic Indicators',
          'Email Support',
        ],
      },
      pro: {
        name: 'Pro',
        price: 29,
        features: [
          'Unlimited Backtests',
          '5 Live Trading Strategies',
          'All Indicators',
          'Priority Support',
          'Custom Alerts',
        ],
      },
      elite: {
        name: 'Elite',
        price: 79,
        features: [
          'Unlimited Everything',
          'Unlimited Live Strategies',
          'API Access',
          'VIP Support',
          'Custom Strategy Development',
        ],
      },
    };

    return plans[planId] || plans.starter;
  }
}
