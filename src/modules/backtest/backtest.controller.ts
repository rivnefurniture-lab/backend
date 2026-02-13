import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { BacktestService } from './backtest.service';
import { RunBacktestDto } from './dto/backtest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from './queue.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { runBacktest as runFastBacktest, BacktestConfig } from '../../engine/backtest-engine';

interface JwtUser {
  sub: string; // Supabase UUID
  email?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}

@Controller('backtest')
export class BacktestController {
  // Cache for userId resolution
  private userIdCache: Map<string, { id: number; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly backtestService: BacktestService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly subscriptionService: SubscriptionService,
  ) { }

  // Resolve Supabase UUID to database user ID (with caching)
  private async getUserId(req: AuthenticatedRequest): Promise<number> {
    const supabaseId = req.user?.sub || '';
    const email = req.user?.email || '';
    
    // Check cache first
    const cached = this.userIdCache.get(supabaseId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.id;
    }
    
    try {
      let user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: { id: true },
      });
      
      if (!user && email) {
        user = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
      }
      
      const userId = user?.id || 1;
      
      // Cache the result
      if (supabaseId && userId !== 1) {
        this.userIdCache.set(supabaseId, { id: userId, timestamp: Date.now() });
      }
      
      return userId;
    } catch {
      // Return cached value if available as fallback
      if (cached) {
        return cached.id;
      }
      return 1;
    }
  }

  @Get('indicators')
  getIndicators() {
    return this.backtestService.getAvailableIndicators();
  }

  @Get('templates')
  getTemplates() {
    return this.backtestService.getStrategyTemplates();
  }

  // Cache for public strategies (60 second TTL - data doesn't change often)
  private strategiesListCache: { data: any[]; timestamp: number } | null = null;
  private readonly STRATEGIES_LIST_CACHE_TTL = 60000; // 60 seconds

  @Get('strategies')
  getAllStrategies(@Res({ passthrough: true }) res: Response) {
    // Tell browsers/CDNs they can cache this for 60s
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');

    // Check in-memory cache first
    if (this.strategiesListCache && Date.now() - this.strategiesListCache.timestamp < this.STRATEGIES_LIST_CACHE_TTL) {
      return this.strategiesListCache.data;
    }

    try {
      // Real backtest data from 2023-2025 with actual trades and yearly breakdown
      const realBacktest = {
        id: 'real-rsi-ma-bb-2023-2025',
        name: 'RSI & Moving Average with Bollinger Bands Exit',
        description:
          'Conservative strategy entering on RSI oversold with EMA confirmation, exiting on Bollinger Bands signals. Tested on 17 pairs over 3 years.',
        category: 'Trend Following',
        cagr: 53,
        sharpe: 1.13,
        sortino: 1.22,
        winRate: 78,
        maxDD: 20,
        totalTrades: 101,
        profitFactor: 7.8,
        netProfitUsd: 12261.76,
        avgDealDuration: '9 days, 7 hours',
        returns: {
          daily: 0.15,
          weekly: 1.02,
          monthly: 4.42,
          yearly: 53,
        },
        yearlyBreakdown: {
          '2023': { return: 17.1, balance: 5855.59, trades: 10, winRate: 90 },
          '2024': { return: 65.9, balance: 9720.28, trades: 39, winRate: 79 },
          '2025': { return: 63.3, balance: 15868.02, trades: 52, winRate: 75 },
        },
        pairs: [
          'BTC/USDT',
          'ETH/USDT',
          'ADA/USDT',
          'SOL/USDT',
          'AVAX/USDT',
          'DOT/USDT',
          'LINK/USDT',
          'ATOM/USDT',
          'NEAR/USDT',
          'LTC/USDT',
          'XRP/USDT',
          'DOGE/USDT',
          'TRX/USDT',
          'HBAR/USDT',
          'SUI/USDT',
          'BCH/USDT',
          'RENDER/USDT',
        ],
        tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
        updatedAt: new Date('2025-12-10'),
        isPreset: true,
        // Equity curve - monthly snapshots 2023-2025
        history: [
          { year: 'Jan 23', value: 5000 },
          { year: 'Apr 23', value: 5075 },
          { year: 'Jul 23', value: 5500 },
          { year: 'Oct 23', value: 5855 },
          { year: 'Jan 24', value: 6026 },
          { year: 'Apr 24', value: 7018 },
          { year: 'Jul 24', value: 8359 },
          { year: 'Oct 24', value: 9720 },
          { year: 'Jan 25', value: 10314 },
          { year: 'Apr 25', value: 13212 },
          { year: 'Jul 25', value: 15126 },
          { year: 'Oct 25', value: 15868 },
        ],
        // Trading conditions configuration
        config: {
          entry_conditions: [
            {
              indicator: 'RSI',
              subfields: {
                Timeframe: '1h',
                'RSI Length': 21,
                'Signal Value': 20,
                Condition: 'Less Than',
              },
            },
            {
              indicator: 'MA',
              subfields: {
                Timeframe: '1h',
                'MA Type': 'EMA',
                'Fast MA': 20,
                'Slow MA': 100,
                Condition: 'Less Than',
              },
            },
          ],
          exit_conditions: [
            {
              indicator: 'BollingerBands',
              subfields: {
                Timeframe: '1d',
                'BB% Period': 50,
                Deviation: 1,
                Condition: 'Greater Than',
                'Signal Value': 0.1,
              },
            },
          ],
        },
        // Sample trades from actual backtest (formatted for frontend)
        recentTrades: [
          {
            date: '2023-01-06',
            time: '04:59:00',
            pair: 'TRX/USDT',
            side: 'BUY',
            entry: 0.0505,
            orderSize: 1000,
            pnl: 0.075, // 7.5%
            pnlUsd: 75.38,
            balance: 5075.38,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-01-08',
            time: '23:59:00',
            pair: 'TRX/USDT',
            side: 'SELL',
            entry: 0.0544,
            orderSize: 1077.46,
            pnl: 0.075,
            pnlUsd: 75.38,
            balance: 5075.38,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-02-09',
            time: '22:59:00',
            pair: 'SOL/USDT',
            side: 'BUY',
            entry: 20.36,
            orderSize: 1014.86,
            pnl: 0.004,
            pnlUsd: 3.95,
            balance: 5079.32,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-03',
            time: '01:59:00',
            pair: 'LTC/USDT',
            side: 'BUY',
            entry: 87.73,
            orderSize: 1015.45,
            pnl: 0.03,
            pnlUsd: 30.69,
            balance: 5110.02,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-03',
            time: '23:59:00',
            pair: 'LTC/USDT',
            side: 'SELL',
            entry: 90.56,
            orderSize: 1048.2,
            pnl: 0.03,
            pnlUsd: 30.69,
            balance: 5110.02,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-03-09',
            time: '19:59:00',
            pair: 'BTC/USDT',
            side: 'BUY',
            entry: 20847.28,
            orderSize: 1021.37,
            pnl: 0.157,
            pnlUsd: 157.82,
            balance: 5504.56,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-13',
            time: '23:59:00',
            pair: 'BTC/USDT',
            side: 'SELL',
            entry: 24113.48,
            orderSize: 1181.4,
            pnl: 0.157,
            pnlUsd: 157.82,
            balance: 5504.56,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
          {
            date: '2023-03-09',
            time: '20:59:00',
            pair: 'ETH/USDT',
            side: 'BUY',
            entry: 1425.82,
            orderSize: 1021.37,
            pnl: 0.108,
            pnlUsd: 108.53,
            balance: 5218.55,
            status: 'Entry',
            comment: 'RSI oversold + EMA confirmation',
          },
          {
            date: '2023-03-12',
            time: '23:59:00',
            pair: 'ETH/USDT',
            side: 'SELL',
            entry: 1580.33,
            orderSize: 1132.06,
            pnl: 0.108,
            pnlUsd: 108.53,
            balance: 5218.55,
            status: 'Exit',
            comment: 'Bollinger Bands exit signal',
          },
        ],
        totalBacktestTrades: 206, // Total from CSV (206 BUY/SELL entries)
      };

      // NOTE: User strategies are private - they are only visible to the user who created them
      // The /strategies/my endpoint returns user's own strategies
      // This public endpoint only shows preset/mock strategies for demonstration
      let userStrategies: any[] = [];

      // NOTE: User backtests are private - they are only visible to the user who created them
      // The /backtest/results endpoint returns user's own backtest results
      // This public endpoint only shows preset/mock strategies for demonstration
      let dbBacktests: any[] = [];

      // Mock strategies - can be hidden via admin panel (stored in env)
      const mockStrategiesEnabled = process.env.SHOW_MOCK_STRATEGIES === 'true';

      const mockStrategies = mockStrategiesEnabled ? [
        {
          id: 'mock-macd-momentum',
          name: 'MACD Momentum Pro',
          description: 'High-frequency momentum strategy using MACD crossovers with volume confirmation. Optimized for volatile market conditions.',
          category: 'Momentum',
          cagr: 42.5,
          sharpe: 1.45,
          sortino: 1.68,
          winRate: 71,
          maxDD: 15.2,
          totalTrades: 287,
          profitFactor: 2.8,
          netProfitUsd: 8520.00,
          avgDealDuration: '4 days, 12 hours',
          returns: { daily: 0.12, weekly: 0.82, monthly: 3.54, yearly: 42.5 },
          yearlyBreakdown: {
            '2023': { return: 38.2, balance: 6910, trades: 95, winRate: 69 },
            '2024': { return: 45.1, balance: 10025, trades: 102, winRate: 72 },
            '2025': { return: 44.8, balance: 14520, trades: 90, winRate: 73 },
          },
          pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'AVAX/USDT', 'LINK/USDT'],
          tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
          updatedAt: new Date(),
          isPreset: true,
          isMock: true,
          history: [
            { year: 'Jan 23', value: 5000 }, { year: 'Apr 23', value: 5420 },
            { year: 'Jul 23', value: 6100 }, { year: 'Oct 23', value: 6910 },
            { year: 'Jan 24', value: 7450 }, { year: 'Apr 24', value: 8320 },
            { year: 'Jul 24', value: 9180 }, { year: 'Oct 24', value: 10025 },
            { year: 'Jan 25', value: 11200 }, { year: 'Apr 25', value: 12650 },
            { year: 'Jul 25', value: 13800 }, { year: 'Oct 25', value: 14520 },
          ],
        },
        {
          id: 'mock-scalper-pro',
          name: 'Scalper Pro V2',
          description: 'Ultra-fast scalping strategy targeting small price movements. Uses RSI divergence with price action confirmation.',
          category: 'Scalping',
          cagr: 67.8,
          sharpe: 1.82,
          sortino: 2.15,
          winRate: 82,
          maxDD: 12.5,
          totalTrades: 543,
          profitFactor: 4.2,
          netProfitUsd: 18450.00,
          avgDealDuration: '18 hours',
          returns: { daily: 0.19, weekly: 1.30, monthly: 5.65, yearly: 67.8 },
          yearlyBreakdown: {
            '2023': { return: 58.4, balance: 7920, trades: 165, winRate: 80 },
            '2024': { return: 72.1, balance: 13630, trades: 198, winRate: 83 },
            '2025': { return: 71.2, balance: 23450, trades: 180, winRate: 84 },
          },
          pairs: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'SHIB/USDT'],
          tags: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT'],
          updatedAt: new Date(),
          isPreset: true,
          isMock: true,
          history: [
            { year: 'Jan 23', value: 5000 }, { year: 'Apr 23', value: 5650 },
            { year: 'Jul 23', value: 6720 }, { year: 'Oct 23', value: 7920 },
            { year: 'Jan 24', value: 9100 }, { year: 'Apr 24', value: 10580 },
            { year: 'Jul 24', value: 12100 }, { year: 'Oct 24', value: 13630 },
            { year: 'Jan 25', value: 15800 }, { year: 'Apr 25', value: 18500 },
            { year: 'Jul 25', value: 21200 }, { year: 'Oct 25', value: 23450 },
          ],
        },
        {
          id: 'mock-grid-trading',
          name: 'Smart Grid Trader',
          description: 'Grid trading strategy with dynamic level adjustment. Performs well in ranging markets with automatic grid recalibration.',
          category: 'Grid Trading',
          cagr: 35.2,
          sharpe: 1.28,
          sortino: 1.45,
          winRate: 88,
          maxDD: 8.5,
          totalTrades: 412,
          profitFactor: 3.5,
          netProfitUsd: 6780.00,
          avgDealDuration: '2 days, 6 hours',
          returns: { daily: 0.10, weekly: 0.68, monthly: 2.93, yearly: 35.2 },
          yearlyBreakdown: {
            '2023': { return: 32.1, balance: 6605, trades: 125, winRate: 87 },
            '2024': { return: 36.8, balance: 9035, trades: 148, winRate: 89 },
            '2025': { return: 36.5, balance: 12340, trades: 139, winRate: 88 },
          },
          pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT'],
          tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
          updatedAt: new Date(),
          isPreset: true,
          isMock: true,
          history: [
            { year: 'Jan 23', value: 5000 }, { year: 'Apr 23', value: 5380 },
            { year: 'Jul 23', value: 5920 }, { year: 'Oct 23', value: 6605 },
            { year: 'Jan 24', value: 7150 }, { year: 'Apr 24', value: 7850 },
            { year: 'Jul 24', value: 8450 }, { year: 'Oct 24', value: 9035 },
            { year: 'Jan 25', value: 9800 }, { year: 'Apr 25', value: 10750 },
            { year: 'Jul 25', value: 11600 }, { year: 'Oct 25', value: 12340 },
          ],
        },
        {
          id: 'mock-breakout-hunter',
          name: 'Breakout Hunter Elite',
          description: 'Volatility breakout strategy targeting major support/resistance levels. Uses ATR-based stop losses and trailing profits.',
          category: 'Breakout',
          cagr: 58.3,
          sharpe: 1.55,
          sortino: 1.92,
          winRate: 65,
          maxDD: 22.1,
          totalTrades: 156,
          profitFactor: 3.1,
          netProfitUsd: 14250.00,
          avgDealDuration: '12 days, 8 hours',
          returns: { daily: 0.16, weekly: 1.12, monthly: 4.86, yearly: 58.3 },
          yearlyBreakdown: {
            '2023': { return: 48.5, balance: 7425, trades: 48, winRate: 63 },
            '2024': { return: 62.1, balance: 12035, trades: 58, winRate: 66 },
            '2025': { return: 64.2, balance: 19750, trades: 50, winRate: 68 },
          },
          pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'AVAX/USDT', 'DOT/USDT', 'ATOM/USDT', 'NEAR/USDT'],
          tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
          updatedAt: new Date(),
          isPreset: true,
          isMock: true,
          history: [
            { year: 'Jan 23', value: 5000 }, { year: 'Apr 23', value: 5680 },
            { year: 'Jul 23', value: 6520 }, { year: 'Oct 23', value: 7425 },
            { year: 'Jan 24', value: 8350 }, { year: 'Apr 24', value: 9680 },
            { year: 'Jul 24', value: 10850 }, { year: 'Oct 24', value: 12035 },
            { year: 'Jan 25', value: 14100 }, { year: 'Apr 25', value: 16500 },
            { year: 'Jul 25', value: 18200 }, { year: 'Oct 25', value: 19750 },
          ],
        },
        {
          id: 'mock-swing-master',
          name: 'Swing Master 3.0',
          description: 'Multi-timeframe swing trading strategy. Combines daily trend analysis with 4H entry signals for optimal risk/reward.',
          category: 'Swing Trading',
          cagr: 45.6,
          sharpe: 1.38,
          sortino: 1.62,
          winRate: 74,
          maxDD: 16.8,
          totalTrades: 89,
          profitFactor: 2.9,
          netProfitUsd: 9850.00,
          avgDealDuration: '21 days',
          returns: { daily: 0.13, weekly: 0.88, monthly: 3.80, yearly: 45.6 },
          yearlyBreakdown: {
            '2023': { return: 41.2, balance: 7060, trades: 28, winRate: 71 },
            '2024': { return: 48.5, balance: 10485, trades: 32, winRate: 75 },
            '2025': { return: 47.1, balance: 15420, trades: 29, winRate: 76 },
          },
          pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT'],
          tags: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
          updatedAt: new Date(),
          isPreset: true,
          isMock: true,
          history: [
            { year: 'Jan 23', value: 5000 }, { year: 'Apr 23', value: 5480 },
            { year: 'Jul 23', value: 6150 }, { year: 'Oct 23', value: 7060 },
            { year: 'Jan 24', value: 7850 }, { year: 'Apr 24', value: 8750 },
            { year: 'Jul 24', value: 9620 }, { year: 'Oct 24', value: 10485 },
            { year: 'Jan 25', value: 11650 }, { year: 'Apr 25', value: 13200 },
            { year: 'Jul 25', value: 14450 }, { year: 'Oct 25', value: 15420 },
          ],
        },
      ] : [];

      // Return real backtest first, then mock strategies, then database backtests, then user strategies
      const result = [realBacktest, ...mockStrategies, ...dbBacktests, ...userStrategies];

      // Cache the result
      this.strategiesListCache = { data: result, timestamp: Date.now() };

      return result;
    } catch (error) {
      console.error('Failed to load strategies:', error.message);
      // Fallback to just the real backtest if everything fails
      return [];
    }
  }

  @Get('preset-strategies')
  async getPresetStrategies() {
    return this.backtestService.getPresetStrategiesWithMetrics();
  }

  @Get('preset-strategies/:id/calculate')
  async calculatePresetStrategy(@Param('id') id: string) {
    return this.backtestService.calculatePresetStrategyMetrics(id);
  }

  // Admin endpoint to get mock strategies visibility status
  @Get('admin/mock-strategies-status')
  getMockStrategiesStatus() {
    return {
      enabled: process.env.SHOW_MOCK_STRATEGIES !== 'false',
      message: process.env.SHOW_MOCK_STRATEGIES !== 'false'
        ? 'Mock strategies are currently visible'
        : 'Mock strategies are currently hidden'
    };
  }

  // Admin endpoint to toggle mock strategies visibility
  // In production, this would require admin authentication
  @Post('admin/toggle-mock-strategies')
  toggleMockStrategies(@Body() body: { enabled: boolean }) {
    // Store in environment variable (note: this is runtime only, not persistent across restarts)
    process.env.SHOW_MOCK_STRATEGIES = body.enabled ? 'true' : 'false';

    // Clear the strategies cache to reflect the change immediately
    this.strategiesListCache = null;

    return {
      success: true,
      enabled: body.enabled,
      message: body.enabled
        ? 'Mock strategies are now visible'
        : 'Mock strategies are now hidden'
    };
  }

  /**
   * Fast in-process backtest — fetches data from Binance, calculates
   * indicators in TypeScript, uses the same condition logic as live trading.
   * No queue, no Python, no Parquet files needed.
   */
  @UseGuards(JwtAuthGuard)
  @Post('run')
  async runBacktest(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RunBacktestDto,
  ) {
    const config: BacktestConfig = {
      strategyName: dto.strategy_name || 'backtest',
      pairs: dto.pairs || [],
      maxActiveDeals: dto.max_active_deals || 1,
      initialBalance: dto.initial_balance || 10000,
      baseOrderSize: dto.base_order_size || 100,
      tradingFee: dto.trading_fee ?? 0.1,
      startDate: dto.start_date || '',
      endDate: dto.end_date || '',
      entryConditions: dto.entry_conditions || [],
      exitConditions: dto.exit_conditions || [],
      safetyOrderToggle: dto.safety_order_toggle || false,
      safetyOrderSize: dto.safety_order_size || 0,
      priceDeviation: dto.price_deviation || 1,
      maxSafetyOrdersCount: dto.max_safety_orders_count || 0,
      safetyOrderVolumeScale: dto.safety_order_volume_scale || 1,
      safetyOrderStepScale: dto.safety_order_step_scale || 1,
      safetyConditions: dto.safety_conditions || [],
      stopLossToggle: dto.stop_loss_toggle || false,
      stopLossValue: dto.stop_loss_value || 0,
      stopLossTimeout: dto.stop_loss_timeout || 0,
      priceChangeActive: dto.price_change_active || false,
      targetProfit: dto.target_profit || 0,
      conditionsActive: dto.conditions_active ?? true,
      reinvestProfit: dto.reinvest_profit || 0,
      riskReduction: dto.risk_reduction || 0,
      cooldownBetweenDeals: dto.cooldown_between_deals || 0,
      closeDealAfterTimeout: dto.close_deal_after_timeout || 0,
      minprofToggle: dto.minprof_toggle || false,
      minimalProfit: dto.minimal_profit || 0,
    };

    const result = await runFastBacktest(config);

    if (result.status === 'success') {
      try {
        const userId = await this.getUserId(req);
        const saved = await this.backtestService.saveBacktestResult(
          userId,
          dto,
          result,
        );
        return { ...result, savedId: saved.id };
      } catch (saveErr: any) {
        // Still return result even if save fails
        return { ...result, saveError: saveErr.message };
      }
    }

    return result;
  }

  @Post('demo')
  async runDemoBacktest(@Body() dto: RunBacktestDto) {
    const config: BacktestConfig = {
      strategyName: dto.strategy_name || 'demo',
      pairs: dto.pairs || [],
      maxActiveDeals: dto.max_active_deals || 1,
      initialBalance: dto.initial_balance || 10000,
      baseOrderSize: dto.base_order_size || 100,
      tradingFee: dto.trading_fee ?? 0.1,
      startDate: dto.start_date || '',
      endDate: dto.end_date || '',
      entryConditions: dto.entry_conditions || [],
      exitConditions: dto.exit_conditions || [],
      conditionsActive: dto.conditions_active ?? true,
      stopLossToggle: dto.stop_loss_toggle || false,
      stopLossValue: dto.stop_loss_value || 0,
      priceChangeActive: dto.price_change_active || false,
      targetProfit: dto.target_profit || 0,
    };
    return runFastBacktest(config);
  }

  // Cache for backtest results (30 second TTL per user)
  private resultsCache = new Map<number, { data: any[]; timestamp: number }>();
  private readonly RESULTS_CACHE_TTL_MS = 30000; // 30 seconds

  @UseGuards(JwtAuthGuard)
  @Get('results')
  async getResults(@Req() req: AuthenticatedRequest) {
    try {
    const userId = await this.getUserId(req);

      // Check cache first
      const cached = this.resultsCache.get(userId);
      if (cached && Date.now() - cached.timestamp < this.RESULTS_CACHE_TTL_MS) {
        console.log(`[getResults] Cache hit for userId: ${userId}`);
        return cached.data;
      }

      console.log(`[getResults] Fetching results for userId: ${userId}`);
      const results = await this.backtestService.getBacktestResults(userId);
      console.log(`[getResults] Found ${results.length} results`);

      // Cache the result
      this.resultsCache.set(userId, { data: results, timestamp: Date.now() });

      return results;
    } catch (error) {
      console.error('[getResults] Error:', error);
      throw error;
    }
  }

  @Get('results/:id')
  async getResult(@Param('id') id: string) {
    // Allow viewing any backtest result (no auth required for viewing)
    return this.backtestService.getBacktestResult(parseInt(id));
  }

  @Get('results/:id/export/csv')
  async exportCSV(@Param('id') id: string, @Res() res: Response) {
    const result = await this.backtestService.getBacktestResult(parseInt(id));
    
    if (!result || !result.trades) {
      return res.status(404).json({ error: 'Backtest result not found' });
    }
    
    const headers = [
      'Date',
      'Time',
      'Symbol',
      'Action',
      'Price',
      'P&L %',
      'P&L $',
      'Equity',
      'Reason',
      'Indicators',
    ];
    const rows = result.trades.map((t: any) =>
      [
        t.date,
        t.time,
        t.symbol,
        t.action,
        t.price,
        t.profit_percent || '0',
        t.profit_usd || '0',
        t.equity,
      `"${t.reason || ''}"`,
        `"${(t.indicatorProof || []).map((p: any) => `${p.indicator}: ${p.value}`).join('; ')}"`,
      ].join(','),
    );
    
    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=backtest_${id}.csv`,
    );
    return res.send(csv);
  }

  @UseGuards(JwtAuthGuard)
  @Post('results/:id/save-as-strategy')
  async saveAsStrategy(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { name: string; description?: string },
  ) {
    const userId = await this.getUserId(req);
    return this.backtestService.saveAsStrategy(
      userId,
      parseInt(id),
      body.name,
      body.description,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('results/:id')
  async deleteResult(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const userId = await this.getUserId(req);
    return this.backtestService.deleteBacktestResult(parseInt(id), userId);
  }

  // Get trades for a preset strategy
  @Get('preset-strategies/:id/trades')
  getStrategyTrades(@Param('id') id: string) {
    return this.backtestService.getStrategyTrades(id);
  }

  // Get full strategy details with trades and metrics
  @Get('preset-strategies/:id/details')
  getStrategyDetails(@Param('id') id: string) {
    return this.backtestService.getStrategyDetails(id);
  }

  // Rerun backtest for a strategy with custom configuration
  @Post('preset-strategies/:id/rerun')
  async rerunStrategyBacktest(
    @Param('id') id: string,
    @Body()
    body: {
      startDate?: string;
      endDate?: string;
      initialCapital?: number;
      pairs?: string[];
      config?: Record<string, any>;
    },
  ) {
    return this.backtestService.rerunBacktestWithConfig(id, body);
  }

  // Get available configuration options for a strategy
  @Get('preset-strategies/:id/config-options')
  getStrategyConfigOptions(@Param('id') id: string) {
    return this.backtestService.getStrategyConfigOptions(id);
  }

  // Data status and management
  @Get('data/status')
  getDataStatus() {
    return this.backtestService.getDataStatus();
  }

  @Post('data/update')
  triggerDataUpdate() {
    return this.backtestService.triggerDataUpdate();
  }

  // ============ QUEUE ENDPOINTS ============

  @UseGuards(JwtAuthGuard)
  @Post('queue')
  async addToQueue(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { payload: RunBacktestDto; notifyVia: 'telegram' | 'email' | 'both' },
  ) {
    const userId = await this.getUserId(req);

    // Check subscription limits
    const canBacktest = await this.subscriptionService.canRunBacktest(userId);
    if (!canBacktest.allowed) {
      return {
        error: canBacktest.reason,
        limitReached: true,
        upgrade: '/pricing',
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, telegramId: true },
    });

    if (!user) {
      return { error: 'User not found' };
    }

    const result = await this.queueService.addToQueue(
      userId,
      body.payload.strategy_name || 'My Strategy',
      body.payload,
      body.notifyVia,
      user.email,
      user.telegramId || undefined,
    );

    return {
      success: true,
      message: 'Backtest added to queue',
      ...result,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/position/:queueId')
  async getQueuePosition(@Param('queueId') queueId: string) {
    const position = await this.queueService.getQueuePosition(
      parseInt(queueId),
    );
    return position || { error: 'Queue item not found' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/my')
  async getMyQueue(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    return this.queueService.getUserQueueItems(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('queue/:id/cancel')
  async cancelBacktest(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const queueItem = await this.prisma.backtestQueue.findFirst({
      where: { id: parseInt(id), userId },
    });

    if (!queueItem) {
      return { error: 'Backtest not found or access denied' };
    }

    if (queueItem.status === 'completed') {
      return { error: 'Cannot cancel completed backtest' };
    }

    await this.prisma.backtestQueue.update({
      where: { id: parseInt(id) },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    return { success: true, message: 'Backtest cancelled' };
  }

  // Admin endpoint to delete queue items
  @UseGuards(JwtAuthGuard)
  @Delete('queue/:id')
  async deleteQueueItem(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const queueItem = await this.prisma.backtestQueue.findUnique({
      where: { id: parseInt(id) },
    });

    if (!queueItem) {
      return { error: 'Queue item not found' };
    }

    // Allow deletion of own items OR if status is failed/cancelled/completed
    const canDelete = queueItem.userId === userId ||
      ['failed', 'cancelled', 'completed'].includes(queueItem.status);

    if (!canDelete) {
      return { error: 'Cannot delete this queue item - must be completed, failed, or cancelled' };
    }

    await this.prisma.backtestQueue.delete({
      where: { id: parseInt(id) },
    });

    return { success: true, message: 'Queue item deleted' };
  }

  // Admin endpoint to force-fail stuck backtests
  @UseGuards(JwtAuthGuard)
  @Post('queue/:id/force-fail')
  async forceFailBacktest(@Param('id') id: string) {
    const queueItem = await this.prisma.backtestQueue.findUnique({
      where: { id: parseInt(id) },
    });

    if (!queueItem) {
      return { error: 'Queue item not found' };
    }

    if (!['queued', 'processing'].includes(queueItem.status)) {
      return { error: 'Can only force-fail queued or processing backtests' };
    }

    await this.prisma.backtestQueue.update({
      where: { id: parseInt(id) },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Manually terminated by admin (stuck backtest)'
      },
    });

    return { success: true, message: 'Backtest marked as failed' };
  }

  // Endpoint to reset stuck backtests (processing for more than 2 hours)
  @UseGuards(JwtAuthGuard)
  @Post('queue/reset-stuck')
  async resetStuckBacktests() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const stuck = await this.prisma.backtestQueue.updateMany({
      where: {
        status: 'processing',
        startedAt: { lt: twoHoursAgo },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Auto-terminated: Processing exceeded 2 hour timeout',
      },
    });

    return {
      success: true,
      message: `Reset ${stuck.count} stuck backtests`,
      count: stuck.count
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('limits')
  async getBacktestLimits(@Req() req: AuthenticatedRequest) {
    const userId = await this.getUserId(req);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionPlan: true },
    });

    const plan = user?.subscriptionPlan || 'free';

    // Define limits per plan
    const limits = {
      free: { monthly: 5, concurrent: 1 },
      starter: { monthly: 20, concurrent: 2 },
      pro: { monthly: 100, concurrent: 5 },
      enterprise: { monthly: -1, concurrent: 10 }, // -1 = unlimited
    };

    const planLimits = limits[plan] || limits.free;

    // Count backtests this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usedThisMonth = await this.prisma.backtestQueue.count({
      where: {
        userId,
        createdAt: { gte: startOfMonth },
        status: { not: 'cancelled' },
      },
    });

    const currentlyRunning = await this.prisma.backtestQueue.count({
      where: {
        userId,
        status: { in: ['queued', 'processing'] },
      },
    });

    return {
      plan,
      limits: planLimits,
      used: {
        monthly: usedThisMonth,
        concurrent: currentlyRunning,
      },
      remaining: {
        monthly: planLimits.monthly === -1 ? -1 : planLimits.monthly - usedThisMonth,
        concurrent: planLimits.concurrent - currentlyRunning,
      },
      canRunBacktest: (planLimits.monthly === -1 || usedThisMonth < planLimits.monthly) &&
        currentlyRunning < planLimits.concurrent,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('queue/stats')
  async getQueueStats() {
    const queued = await this.prisma.backtestQueue.count({
      where: { status: 'queued' },
    });
    const processing = await this.prisma.backtestQueue.count({
      where: { status: 'processing' },
    });
    const completed = await this.prisma.backtestQueue.count({
      where: { status: 'completed' },
    });

    // Calculate total estimated wait time
    const queuedItems = await this.prisma.backtestQueue.findMany({
      where: { status: { in: ['queued', 'processing'] } },
      select: { payload: true, startedAt: true, status: true },
    });

    let totalWaitSeconds = 0;
    for (const item of queuedItems) {
      const estimated = this.queueService.estimateBacktestTime(JSON.parse(item.payload));
      if (item.status === 'processing' && item.startedAt) {
        const elapsed = (Date.now() - item.startedAt.getTime()) / 1000;
        totalWaitSeconds += Math.max(0, estimated - elapsed);
      } else {
        totalWaitSeconds += estimated;
      }
    }

    return {
      queued,
      processing,
      completed,
      totalInQueue: queued + processing,
      estimatedWaitSeconds: Math.ceil(totalWaitSeconds),
      estimatedWaitMinutes: Math.ceil(totalWaitSeconds / 60),
    };
  }

  // Admin endpoint - get all queue items with time estimates
  @UseGuards(JwtAuthGuard)
  @Get('queue/all')
  async getAllQueueItems() {
    const items = await this.prisma.backtestQueue.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: { user: { select: { email: true, name: true } } },
    });

    // Add time estimates to each item
    const itemsWithEstimates = await Promise.all(
      items.map(async (item) => {
        const estimate = await this.queueService.getEstimatedCompletionTime(item.id);
        return {
          ...item,
          estimatedSeconds: estimate?.estimatedSeconds || 0,
          estimatedCompletion: estimate?.estimatedCompletion || null,
          progress: estimate?.progress || 0,
        };
      })
    );

    return itemsWithEstimates;
  }

  // Simple in-memory cache for active backtests (5 second TTL per user)
  private activeBacktestsCache = new Map<string, { data: any[]; timestamp: number }>();
  private readonly CACHE_TTL_MS = 5000; // 5 seconds

  // Get detailed status for user's active backtest (for floating monitor)
  // OPTIMIZED: Uses cache + single DB query to prevent connection pool exhaustion
  @UseGuards(JwtAuthGuard)
  @Get('queue/my-active')
  async getMyActiveBacktests(@Req() req: AuthenticatedRequest) {
    try {
      // Get supabaseId directly from token - avoid extra DB call
      const supabaseId = req.user?.sub;
      if (!supabaseId) {
        return [];
      }

      // Check cache first
      const cached = this.activeBacktestsCache.get(supabaseId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.data;
      }

      // Single query: get user and their active backtests in one go
      const user = await this.prisma.user.findFirst({
        where: { supabaseId },
        select: {
          id: true,
          backtestQueue: {
            where: { status: { in: ['queued', 'processing'] } },
            orderBy: { createdAt: 'desc' },
            take: 5, // Limit to 5 active backtests
          },
        },
      });

      if (!user || !user.backtestQueue?.length) {
        this.activeBacktestsCache.set(supabaseId, { data: [], timestamp: Date.now() });
        return [];
      }

      // Use actual progress from DB (updated by worker) + calculate remaining time
      const result = user.backtestQueue.map((item, index) => {
        // Use actual progress from database (worker updates this)
        const progress = item.progress || 0;
        // Use estimated duration from database if available, otherwise default
        const totalEstimated = (item as any).estimatedSeconds || 120;

        let estimatedRemaining = totalEstimated;
        if (item.status === 'processing' && progress > 0) {
          // Calculate remaining based on actual progress
          estimatedRemaining = Math.max(5, totalEstimated * (1 - progress / 100));
        }

        return {
          id: item.id,
          strategyName: item.strategyName,
          status: item.status,
          queuePosition: index + 1,
          progress,
          estimatedSeconds: totalEstimated,
          estimatedRemaining,
          estimatedCompletion: new Date(Date.now() + estimatedRemaining * 1000).toISOString(),
          startedAt: item.startedAt,
          createdAt: item.createdAt,
          notifyVia: item.notifyVia,
        };
      });

      // Cache the result
      this.activeBacktestsCache.set(supabaseId, { data: result, timestamp: Date.now() });
      return result;
    } catch (e) {
      // Silent fail - return empty array (don't crash on DB errors)
      return [];
    }
  }

  // Admin analytics endpoint
  @UseGuards(JwtAuthGuard)
  @Get('admin/analytics')
  async getAdminAnalytics() {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // User statistics
      const totalUsers = await this.prisma.user.count();
      const usersBySubscription = await this.prisma.user.groupBy({
        by: ['subscriptionPlan'],
        _count: true,
      });

      const subscriptionStats = {
        free:
          usersBySubscription.find((u) => u.subscriptionPlan === 'free')
            ?._count || 0,
        starter:
          usersBySubscription.find((u) => u.subscriptionPlan === 'starter')
            ?._count || 0,
        pro:
          usersBySubscription.find((u) => u.subscriptionPlan === 'pro')
            ?._count || 0,
        enterprise:
          usersBySubscription.find((u) => u.subscriptionPlan === 'enterprise')
            ?._count || 0,
      };

      // Strategy statistics
      const totalStrategies = await this.prisma.strategy.count();
      const activeStrategies = await this.prisma.strategy.count({
        where: { isActive: true },
      });
      const publicStrategies = await this.prisma.strategy.count({
        where: { isPublic: true },
      });

      // Backtest statistics
      const totalBacktests = await this.prisma.backtestResult.count();
      const backtestsLast24h = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: oneDayAgo } },
      });
      const backtestsLast7d = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      });
      const backtestsLast30d = await this.prisma.backtestResult.count({
        where: { createdAt: { gte: thirtyDaysAgo } },
      });

      // Queue statistics
      const queueStats = await this.getQueueStats();

      // Recent signups
      const recentSignups = await this.prisma.user.count({
        where: { createdAt: { gte: sevenDaysAgo } },
      });

      // Average backtest metrics
      const avgMetrics = await this.prisma.backtestResult.aggregate({
        _avg: {
          sharpeRatio: true,
          winRate: true,
          yearlyReturn: true,
        },
      });

      // System health
      const systemHealth = {
        database: 'healthy',
        api: 'healthy',
        worker: 'unknown', // Will be updated by worker status check
        uptime: Math.floor(process.uptime()),
      };

      return {
        users: {
          total: totalUsers,
          bySubscription: subscriptionStats,
          recentSignups,
        },
        strategies: {
          total: totalStrategies,
          active: activeStrategies,
          public: publicStrategies,
        },
        backtests: {
          total: totalBacktests,
          last24h: backtestsLast24h,
          last7d: backtestsLast7d,
          last30d: backtestsLast30d,
          avgSharpe: avgMetrics._avg.sharpeRatio || 0,
          avgWinRate: avgMetrics._avg.winRate || 0,
          avgYearlyReturn: avgMetrics._avg.yearlyReturn || 0,
        },
        queue: queueStats,
        system: systemHealth,
      };
    } catch (error) {
      console.error('Failed to fetch admin analytics:', error);
      return {
        users: {
          total: 0,
          bySubscription: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          recentSignups: 0,
        },
        strategies: { total: 0, active: 0, public: 0 },
        backtests: {
          total: 0,
          last24h: 0,
          last7d: 0,
          last30d: 0,
          avgSharpe: 0,
          avgWinRate: 0,
          avgYearlyReturn: 0,
        },
        queue: {
          queued: 0,
          processing: 0,
          completed: 0,
          totalInQueue: 0,
          estimatedWaitMinutes: 0,
        },
        system: {
          database: 'unknown',
          api: 'unknown',
          worker: 'unknown',
          uptime: 0,
        },
      };
    }
  }

  // Get all trades for a strategy
  @Get('strategies/:id/all-trades')
  async getAllStrategyTrades(@Param('id') id: string) {
    // For the real strategy, load from JSON file
    if (id === 'real-rsi-ma-bb-2023-2025') {
      try {
        const fs = require('fs');
        const path = require('path');
        const tradesPath = path.join(process.cwd(), 'data', 'real_strategy_trades.json');
        const tradesData = fs.readFileSync(tradesPath, 'utf-8');
        const allTrades = JSON.parse(tradesData);
        return {
          strategyId: id,
          total: allTrades.length,
          trades: allTrades,
        };
      } catch (e) {
        return {
          strategyId: id,
          total: 0,
          trades: [],
          error: 'Trades file not found',
        };
      }
    }

    // For other strategies, return empty for now
    return {
      strategyId: id,
      total: 0,
      trades: [],
    };
  }

  // Admin recent activity endpoint
  @UseGuards(JwtAuthGuard)
  @Get('admin/recent-activity')
  async getRecentActivity() {
    try {
      // Recent backtests
      const recentBacktests = await this.prisma.backtestResult.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // Recent queue items
      const recentQueueItems = await this.prisma.backtestQueue.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // Recent user signups
      const recentUsers = await this.prisma.user.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          subscriptionPlan: true,
          createdAt: true,
        },
      });

      return {
        backtests: recentBacktests.map((b) => ({
          id: b.id,
          name: b.name,
          user: b.user?.name || 'Unknown',
          netProfit: b.netProfitUsd,
          sharpe: b.sharpeRatio,
          winRate: b.winRate,
          createdAt: b.createdAt,
        })),
        queueItems: recentQueueItems.map((q) => ({
          id: q.id,
          strategyName: q.strategyName,
          user: q.user?.name || 'Unknown',
          status: q.status,
          createdAt: q.createdAt,
          completedAt: q.completedAt,
        })),
        users: recentUsers,
      };
    } catch (error) {
      console.error('Failed to fetch recent activity:', error);
      return {
        backtests: [],
        queueItems: [],
        users: [],
      };
    }
  }
}

