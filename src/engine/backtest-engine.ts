/**
 * backtest-engine.ts — Fast, in-process TypeScript backtest engine.
 *
 * Fetches OHLCV data from Binance (public, no auth needed) via CCXT,
 * calculates indicators on-the-fly, processes trades, and returns results.
 *
 * This uses the EXACT same condition logic as live trading (conditions.ts).
 */

import * as ccxt from 'ccxt';
import { Candle, buildIndicatorMaps, IndicatorSpec } from './indicators';
import { checkAllConditions, ConditionSpec } from './conditions';

// ── Types ────────────────────────────────────────────────────────────

export interface BacktestConfig {
  strategyName: string;
  pairs: string[];
  maxActiveDeals: number;
  initialBalance: number;
  baseOrderSize: number;
  tradingFee: number; // percentage, e.g. 0.1 means 0.1%
  startDate: string;
  endDate: string;
  entryConditions: ConditionSpec[];
  exitConditions: ConditionSpec[];
  safetyOrderToggle?: boolean;
  safetyOrderSize?: number;
  priceDeviation?: number; // %
  maxSafetyOrdersCount?: number;
  safetyOrderVolumeScale?: number;
  safetyOrderStepScale?: number;
  safetyConditions?: ConditionSpec[];
  stopLossToggle?: boolean;
  stopLossValue?: number; // %
  stopLossTimeout?: number; // minutes
  priceChangeActive?: boolean;
  targetProfit?: number; // %
  conditionsActive?: boolean;
  reinvestProfit?: number; // %
  riskReduction?: number; // %
  cooldownBetweenDeals?: number; // minutes
  closeDealAfterTimeout?: number; // minutes
  minprofToggle?: boolean;
  minimalProfit?: number; // percentage value, e.g. 1 means 1%
  timeframe?: string; // override processing timeframe
}

export interface TradeRecord {
  timestamp: string;
  symbol: string;
  action: string;
  price: number;
  quantity: number;
  amount: number;
  totalAmount: number;
  profitPercent: number | string;
  moveFromEntry: number;
  tradeId: string;
  comment: string;
}

export interface BacktestMetrics {
  net_profit: number;
  total_profit: number;
  net_profit_usd: number;
  total_profit_usd: number;
  max_drawdown: number;
  max_realized_drawdown: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  win_rate: number;
  total_trades: number;
  profit_factor: number | string;
  avg_profit_per_trade: number;
  yearly_return: number;
  exposure_time_frac: number;
}

export interface BacktestResult {
  status: 'success' | 'error';
  message: string;
  metrics?: BacktestMetrics;
  trades?: TradeRecord[];
  chartData?: {
    timestamps: string[];
    balanceHistory: number[];
    drawdown: number[];
  };
  runTime?: number;
  pairsUsed?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function getLowestTimeframe(conditions: ConditionSpec[]): string {
  let lowestMs = Infinity;
  let lowestTf = '1h'; // default
  for (const c of conditions) {
    const tf = c.subfields?.Timeframe || '1m';
    const ms = TIMEFRAME_MS[tf] || TIMEFRAME_MS['1h'];
    if (ms < lowestMs) {
      lowestMs = ms;
      lowestTf = tf;
    }
  }
  return lowestTf;
}

/** Fetch OHLCV candles from Binance public API */
async function fetchCandles(
  exchange: ccxt.Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let fetchSince = since;
  const limit = 1000;
  const tfMs = TIMEFRAME_MS[timeframe] || TIMEFRAME_MS['1h'];

  while (fetchSince < until) {
    try {
      const ohlcv = await exchange.fetchOHLCV(
        symbol,
        timeframe,
        fetchSince,
        limit,
      );
      if (!ohlcv || ohlcv.length === 0) break;

      for (const bar of ohlcv) {
        if (bar[0] > until) break;
        all.push({
          timestamp: bar[0],
          open: bar[1],
          high: bar[2],
          low: bar[3],
          close: bar[4],
          volume: bar[5],
        });
      }

      const lastTs = ohlcv[ohlcv.length - 1][0];
      if (lastTs <= fetchSince) break; // no progress
      fetchSince = lastTs + tfMs;

      // Rate limiting: small delay between requests
      await new Promise((r) => setTimeout(r, 100));
    } catch (err: any) {
      console.error(`Error fetching ${symbol} ${timeframe}: ${err.message}`);
      break;
    }
  }

  return all;
}

// ── Main Engine ──────────────────────────────────────────────────────

export async function runBacktest(
  config: BacktestConfig,
): Promise<BacktestResult> {
  const startTime = Date.now();

  try {
    const {
      pairs,
      maxActiveDeals,
      initialBalance,
      baseOrderSize,
      entryConditions,
      exitConditions,
      safetyConditions = [],
      safetyOrderToggle = false,
      safetyOrderSize = 0,
      priceDeviation = 1,
      maxSafetyOrdersCount = 0,
      safetyOrderVolumeScale = 1,
      safetyOrderStepScale = 1,
      stopLossToggle = false,
      stopLossValue = 0,
      stopLossTimeout = 0,
      priceChangeActive = false,
      targetProfit = 0,
      conditionsActive = false,
      reinvestProfit = 0,
      riskReduction = 0,
      cooldownBetweenDeals = 0,
      closeDealAfterTimeout = 0,
      minprofToggle = false,
      minimalProfit = 0,
    } = config;

    if (!pairs || pairs.length === 0) {
      return { status: 'error', message: 'No pairs selected.' };
    }

    const tradingFee = (config.tradingFee || 0.1) / 100;
    const slFrac = stopLossToggle && stopLossValue > 0 ? stopLossValue / 100 : 0;
    const tpFrac = targetProfit > 0 ? targetProfit / 100 : 0;
    const devFrac =
      safetyOrderToggle && maxSafetyOrdersCount > 0 ? priceDeviation / 100 : 0;
    const minProfFrac = minimalProfit / 100;
    const cooldownMs = cooldownBetweenDeals * 60_000;
    const slTimeoutMs = stopLossTimeout * 60_000;
    const dealTimeoutMs = closeDealAfterTimeout * 60_000;
    const hasEntryConditions = entryConditions.length > 0;
    const hasExitConditions = conditionsActive && exitConditions.length > 0;

    // Determine processing timeframe
    const allConditions = [
      ...entryConditions,
      ...exitConditions,
      ...safetyConditions,
    ];
    const processingTf = config.timeframe || getLowestTimeframe(allConditions);
    const tfMs = TIMEFRAME_MS[processingTf] || TIMEFRAME_MS['1h'];

    // Date parsing
    const sinceMs = new Date(config.startDate).getTime();
    const untilMs = new Date(config.endDate).getTime();
    if (isNaN(sinceMs) || isNaN(untilMs) || untilMs <= sinceMs) {
      return { status: 'error', message: 'Invalid date range.' };
    }

    // Create exchange for data fetching (public, no auth)
    const exchange = new ccxt.binance({ enableRateLimit: true });

    // ── Fetch data for all pairs in parallel ──
    const pairDataMap: Map<
      string,
      { candles: Candle[]; indicators: Record<string, number>[] }
    > = new Map();

    const fetchPromises = pairs.map(async (symbol) => {
      const candles = await fetchCandles(
        exchange,
        symbol,
        processingTf,
        sinceMs,
        untilMs,
      );
      if (candles.length === 0) return;

      // Build indicator maps
      const indicators = buildIndicatorMaps(
        candles,
        allConditions as IndicatorSpec[],
      );
      pairDataMap.set(symbol, { candles, indicators });
    });

    await Promise.all(fetchPromises);

    if (pairDataMap.size === 0) {
      return {
        status: 'error',
        message: 'No data available for the selected pairs and date range.',
      };
    }

    // ── Merge all pairs into a timeline sorted by timestamp ──
    interface TimelineRow {
      timestamp: number;
      symbol: string;
      candle: Candle;
      data: Record<string, number>;
      prevData: Record<string, number> | null;
    }

    const timeline: TimelineRow[] = [];
    for (const [symbol, { candles, indicators }] of pairDataMap) {
      for (let i = 0; i < candles.length; i++) {
        timeline.push({
          timestamp: candles[i].timestamp,
          symbol,
          candle: candles[i],
          data: indicators[i],
          prevData: i > 0 ? indicators[i - 1] : null,
        });
      }
    }
    timeline.sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));

    // ── Trading simulation ──
    interface ActiveTrade {
      tradeId: string;
      symbol: string;
      quantity: number;
      entryPrice: number;
      totalAmount: number;
      placedSoCount: number;
      lastSoSize: number;
      soDevFactor: number;
      nextSoPrice: number | null;
      stopLossThreshold: number | null;
      takeProfitThreshold: number | null;
      timeOpened: number;
    }

    const activeTrades: Map<string, ActiveTrade> = new Map();
    const lastCloseTime: Map<string, number> = new Map();
    const trades: TradeRecord[] = [];
    let tradeIdCounter = 0;
    let globalActiveDeals = 0;
    let freeCash = initialBalance;
    let realBalance = initialBalance;
    const positionsBySymbol: Map<string, number> = new Map();
    const lastClosePrice: Map<string, number> = new Map();
    let maxBalanceSoFar = initialBalance;
    let maxDrawdownSoFar = 0;
    let maxRealBalanceSoFar = initialBalance;
    let maxRealDrawdownSoFar = 0;

    // For chart data (sample every N bars)
    const chartTimestamps: string[] = [];
    const chartBalance: number[] = [];
    const chartDrawdown: number[] = [];
    const sampleInterval = Math.max(1, Math.floor(timeline.length / 500));

    // Group timeline by timestamp for batch processing (candidate selection)
    let candidates: TimelineRow[] = [];
    let lastTs = -1;

    const processCandidates = () => {
      if (candidates.length === 0) return;
      candidates.sort((a, b) => a.candle.close - b.candle.close);
      const slots = maxActiveDeals - globalActiveDeals;
      const selected = candidates.slice(0, Math.max(0, slots));

      for (const cand of selected) {
        const entryPrice = cand.candle.close;
        tradeIdCounter++;
        const tradeId = `${tradeIdCounter}-${cand.symbol}`;
        const qty = baseOrderSize / entryPrice;
        const amount = entryPrice * qty;

        const trade: ActiveTrade = {
          tradeId,
          symbol: cand.symbol,
          quantity: qty,
          entryPrice,
          totalAmount: amount,
          placedSoCount: 0,
          lastSoSize: safetyOrderSize,
          soDevFactor: priceDeviation,
          nextSoPrice:
            safetyOrderToggle && maxSafetyOrdersCount > 0
              ? entryPrice * (1 - devFrac)
              : null,
          stopLossThreshold:
            stopLossToggle && stopLossValue > 0
              ? entryPrice * (1 - slFrac)
              : null,
          takeProfitThreshold:
            targetProfit > 0 ? entryPrice * (1 + tpFrac) : null,
          timeOpened: cand.timestamp,
        };

        activeTrades.set(cand.symbol, trade);
        globalActiveDeals++;
        freeCash -= amount * (1 + tradingFee);
        positionsBySymbol.set(
          cand.symbol,
          (positionsBySymbol.get(cand.symbol) || 0) + qty,
        );

        trades.push({
          timestamp: new Date(cand.timestamp).toISOString(),
          symbol: cand.symbol,
          action: 'BUY',
          price: entryPrice,
          quantity: qty,
          amount,
          totalAmount: amount,
          profitPercent: '',
          moveFromEntry: 0,
          tradeId,
          comment: 'Entry signal',
        });
      }
      candidates = [];
    };

    const closeTrade = (
      trade: ActiveTrade,
      row: TimelineRow,
      exitPrice: number,
      reason: string,
    ) => {
      const qty = trade.quantity;
      const exitAmount = exitPrice * qty;
      const profitPercent =
        trade.totalAmount > 0
          ? (exitAmount - trade.totalAmount) / trade.totalAmount
          : 0;
      const profitLoss =
        exitAmount * (1 - tradingFee) - trade.totalAmount;

      trades.push({
        timestamp: new Date(row.timestamp).toISOString(),
        symbol: trade.symbol,
        action: reason,
        price: exitPrice,
        quantity: qty,
        amount: exitAmount,
        totalAmount: trade.totalAmount,
        profitPercent,
        moveFromEntry:
          trade.entryPrice > 0
            ? (exitPrice - trade.entryPrice) / trade.entryPrice
            : 0,
        tradeId: trade.tradeId,
        comment: reason,
      });

      activeTrades.delete(trade.symbol);
      globalActiveDeals--;
      lastCloseTime.set(trade.symbol, row.timestamp);
      freeCash += exitAmount * (1 - tradingFee);
      positionsBySymbol.set(
        trade.symbol,
        (positionsBySymbol.get(trade.symbol) || 0) - qty,
      );

      realBalance += profitLoss;
      if (realBalance > maxRealBalanceSoFar) maxRealBalanceSoFar = realBalance;
      const realDD =
        maxRealBalanceSoFar > 0
          ? (maxRealBalanceSoFar - realBalance) / maxRealBalanceSoFar
          : 0;
      if (realDD > maxRealDrawdownSoFar) maxRealDrawdownSoFar = realDD;
    };

    // ── Main loop ──
    for (let i = 0; i < timeline.length; i++) {
      const row = timeline[i];
      const { timestamp, symbol, candle, data, prevData } = row;
      const closePrice = candle.close;

      lastClosePrice.set(symbol, closePrice);

      // Check cooldown
      const lastClose = lastCloseTime.get(symbol) || 0;
      if (cooldownMs > 0 && timestamp - lastClose < cooldownMs) continue;

      // Process candidate batch at timestamp boundary
      if (timestamp !== lastTs && lastTs !== -1) {
        processCandidates();
      }
      lastTs = timestamp;

      const trade = activeTrades.get(symbol);

      if (!trade) {
        // Check entry
        if (hasEntryConditions && checkAllConditions(data, prevData, entryConditions)) {
          candidates.push(row);
        }
      } else {
        const moveFromEntry =
          trade.entryPrice > 0
            ? (closePrice - trade.entryPrice) / trade.entryPrice
            : 0;

        // 1) Stop loss
        if (
          stopLossToggle &&
          trade.stopLossThreshold != null &&
          candle.low <= trade.stopLossThreshold
        ) {
          const timeSinceOpen = timestamp - trade.timeOpened;
          if (timeSinceOpen >= slTimeoutMs) {
            closeTrade(trade, row, trade.stopLossThreshold, 'Stop Loss EXIT');
            continue;
          }
        }

        // 2) Deal timeout
        if (dealTimeoutMs > 0 && timestamp - trade.timeOpened >= dealTimeoutMs) {
          closeTrade(trade, row, closePrice, 'Timeout EXIT');
          continue;
        }

        // 3) Exit conditions
        if (hasExitConditions && checkAllConditions(data, prevData, exitConditions)) {
          const exitAmount = closePrice * trade.quantity;
          const profitPct =
            trade.totalAmount > 0
              ? (exitAmount - trade.totalAmount) / trade.totalAmount
              : 0;
          if (!minprofToggle || profitPct >= minProfFrac) {
            closeTrade(trade, row, closePrice, 'SELL');
            continue;
          }
        }

        // 4) Take profit
        if (
          priceChangeActive &&
          trade.takeProfitThreshold != null &&
          candle.high >= trade.takeProfitThreshold
        ) {
          closeTrade(
            trade,
            row,
            trade.takeProfitThreshold,
            'Take Profit EXIT',
          );
          continue;
        }

        // 5) Safety orders
        if (
          safetyOrderToggle &&
          trade.placedSoCount < maxSafetyOrdersCount &&
          trade.nextSoPrice != null &&
          closePrice < trade.nextSoPrice
        ) {
          let soSize = trade.lastSoSize;
          let ordersToTrigger = 0;
          let tempNext = trade.nextSoPrice;
          let tempDev = trade.soDevFactor;

          const remaining = maxSafetyOrdersCount - trade.placedSoCount;
          for (let j = 0; j < remaining; j++) {
            if (closePrice < tempNext) {
              ordersToTrigger++;
              tempDev *= safetyOrderStepScale;
              tempNext *= 1 - (priceDeviation * tempDev) / 100;
            } else break;
          }

          for (let j = 0; j < ordersToTrigger; j++) {
            const soQty = soSize / closePrice;
            trade.placedSoCount++;
            trade.quantity += soQty;
            const orderAmount = closePrice * soQty;
            trade.totalAmount += orderAmount;

            if (tpFrac > 0 && trade.quantity > 0) {
              const avgPrice = trade.totalAmount / trade.quantity;
              trade.takeProfitThreshold = avgPrice * (1 + tpFrac);
            }

            trades.push({
              timestamp: new Date(timestamp).toISOString(),
              symbol,
              action: `Safety Order #${trade.placedSoCount}`,
              price: closePrice,
              quantity: soQty,
              amount: orderAmount,
              totalAmount: trade.totalAmount,
              profitPercent: '',
              moveFromEntry,
              tradeId: trade.tradeId,
              comment: `Safety order #${trade.placedSoCount}`,
            });

            trade.soDevFactor *= safetyOrderStepScale;
            trade.nextSoPrice =
              closePrice *
              (1 - (priceDeviation * trade.soDevFactor) / 100);
            soSize *= safetyOrderVolumeScale;
            freeCash -= orderAmount * (1 + tradingFee);
            positionsBySymbol.set(
              symbol,
              (positionsBySymbol.get(symbol) || 0) + soQty,
            );
          }
          trade.lastSoSize = soSize;
        }
      }

      // Update unrealized balance
      let unrealizedBalance = freeCash;
      for (const [s, q] of positionsBySymbol) {
        const price = lastClosePrice.get(s) || 0;
        unrealizedBalance += q * price * (1 - tradingFee);
      }
      if (unrealizedBalance > maxBalanceSoFar) maxBalanceSoFar = unrealizedBalance;
      const dd =
        maxBalanceSoFar > 0
          ? (maxBalanceSoFar - unrealizedBalance) / maxBalanceSoFar
          : 0;
      if (dd > maxDrawdownSoFar) maxDrawdownSoFar = dd;

      // Sample chart data
      if (i % sampleInterval === 0) {
        chartTimestamps.push(new Date(timestamp).toISOString());
        chartBalance.push(Math.round(unrealizedBalance * 100) / 100);
        chartDrawdown.push(Math.round(dd * 10000) / 10000);
      }
    }

    // Process any remaining candidates
    processCandidates();

    // ── Compute metrics ──
    const sellTrades = trades.filter(
      (t) =>
        t.action.includes('SELL') ||
        t.action.includes('EXIT') ||
        t.action.includes('Timeout'),
    );
    const totalTrades = sellTrades.length;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;

    for (const t of sellTrades) {
      const pl =
        t.amount * (1 - tradingFee) - t.totalAmount;
      if (pl > 0) {
        grossProfit += pl;
        wins++;
      } else {
        grossLoss += Math.abs(pl);
      }
    }

    const netProfitUsd = realBalance - initialBalance;
    const netProfit = initialBalance > 0 ? netProfitUsd / initialBalance : 0;
    const totalMs = untilMs - sinceMs;
    const totalYears = totalMs / (365.25 * 24 * 3600 * 1000);
    const yearlyReturn =
      totalYears > 0 ? Math.pow(1 + netProfit, 1 / totalYears) - 1 : 0;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const profitFactor =
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? Infinity
          : 1;
    const avgProfitPerTrade =
      totalTrades > 0 ? (grossProfit - grossLoss) / totalTrades : 0;

    // Simplified Sharpe/Sortino from chart balance data
    const dailyReturns: number[] = [];
    for (let i = 1; i < chartBalance.length; i++) {
      if (chartBalance[i - 1] > 0) {
        dailyReturns.push(
          (chartBalance[i] - chartBalance[i - 1]) / chartBalance[i - 1],
        );
      }
    }

    const mean =
      dailyReturns.length > 0
        ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
        : 0;
    const variance =
      dailyReturns.length > 1
        ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) /
          (dailyReturns.length - 1)
        : 0;
    const stdDev = Math.sqrt(variance);
    const negReturns = dailyReturns.filter((r) => r < 0);
    const downsideVar =
      negReturns.length > 0
        ? negReturns.reduce((a, b) => a + b ** 2, 0) / negReturns.length
        : 0;
    const downsideStd = Math.sqrt(downsideVar);

    // Annualize based on samples per year
    const samplesPerYear = totalYears > 0 ? chartBalance.length / totalYears : 252;
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(samplesPerYear) : 0;
    const sortino =
      downsideStd > 0
        ? (mean / downsideStd) * Math.sqrt(samplesPerYear)
        : 0;

    const metrics: BacktestMetrics = {
      net_profit: netProfit,
      total_profit: netProfit,
      net_profit_usd: Math.round(netProfitUsd * 100) / 100,
      total_profit_usd: Math.round(netProfitUsd * 100) / 100,
      max_drawdown: Math.round(maxDrawdownSoFar * 10000) / 10000,
      max_realized_drawdown:
        Math.round(maxRealDrawdownSoFar * 10000) / 10000,
      sharpe_ratio: Math.round(sharpe * 100) / 100,
      sortino_ratio: Math.round(sortino * 100) / 100,
      win_rate: Math.round(winRate * 10000) / 10000,
      total_trades: totalTrades,
      profit_factor:
        typeof profitFactor === 'number'
          ? Math.round(profitFactor * 100) / 100
          : 'Infinity',
      avg_profit_per_trade: Math.round(avgProfitPerTrade * 100) / 100,
      yearly_return: Math.round(yearlyReturn * 10000) / 10000,
      exposure_time_frac: 0,
    };

    return {
      status: 'success',
      message: `Backtest completed. ${totalTrades} trades across ${pairDataMap.size} pairs.`,
      metrics,
      trades: trades.slice(0, 200), // return first 200 for display
      chartData: {
        timestamps: chartTimestamps,
        balanceHistory: chartBalance,
        drawdown: chartDrawdown,
      },
      runTime: Date.now() - startTime,
      pairsUsed: pairDataMap.size,
    };
  } catch (err: any) {
    return {
      status: 'error',
      message: err.message || 'Backtest failed',
      runTime: Date.now() - startTime,
    };
  }
}
