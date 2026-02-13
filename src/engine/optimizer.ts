/**
 * optimizer.ts — Strategy Optimizer Engine
 *
 * Takes parameter ranges, generates combinations, runs backtests
 * in batches, and returns ranked results.
 */

import { runBacktest, BacktestConfig, BacktestResult } from './backtest-engine';

// ── Types ────────────────────────────────────────────────────────────

export interface ParameterRange {
  /** Which parameter to vary */
  param: string;
  /** Array of values to try (e.g. [7, 14, 21] or ['1h', '4h']) */
  values: (number | string)[];
}

export type OptimizationGoal =
  | 'maxProfit'
  | 'bestSharpe'
  | 'bestSortino'
  | 'highestWinRate'
  | 'lowestDrawdown'
  | 'bestProfitFactor';

export interface OptimizeRequest {
  /** Base config that stays constant */
  baseConfig: Partial<BacktestConfig>;
  /** Parameters to sweep */
  parameters: ParameterRange[];
  /** What to optimize for */
  goal: OptimizationGoal;
  /** Max number of combinations to run (for safety) */
  maxCombinations?: number;
  /** Concurrency for parallel runs */
  concurrency?: number;
}

export interface OptimizationRun {
  id: number;
  params: Record<string, number | string>;
  result: BacktestResult;
  score: number;
}

export interface OptimizeResult {
  status: 'success' | 'error';
  message: string;
  totalCombinations: number;
  completedRuns: number;
  failedRuns: number;
  bestRun: OptimizationRun | null;
  topRuns: OptimizationRun[];
  allRuns: OptimizationRun[];
  runtime: number;
  goal: OptimizationGoal;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Generate all combinations of parameter values */
function generateCombinations(
  parameters: ParameterRange[],
): Record<string, number | string>[] {
  if (parameters.length === 0) return [{}];

  const [first, ...rest] = parameters;
  const restCombinations = generateCombinations(rest);

  const results: Record<string, number | string>[] = [];
  for (const value of first.values) {
    for (const combo of restCombinations) {
      results.push({ [first.param]: value, ...combo });
    }
  }
  return results;
}

/** Score a backtest result based on the optimization goal */
function scoreResult(result: BacktestResult, goal: OptimizationGoal): number {
  if (result.status !== 'success' || !result.metrics) return -Infinity;

  const m = result.metrics;
  switch (goal) {
    case 'maxProfit':
      return m.net_profit_usd;
    case 'bestSharpe':
      return m.sharpe_ratio;
    case 'bestSortino':
      return m.sortino_ratio;
    case 'highestWinRate':
      return m.win_rate;
    case 'lowestDrawdown':
      return m.max_drawdown === 0 ? 0 : -m.max_drawdown; // lower is better
    case 'bestProfitFactor':
      return typeof m.profit_factor === 'number' ? m.profit_factor : 999;
    default:
      return m.net_profit_usd;
  }
}

/** Apply parameter overrides to a base config, building proper conditions */
function applyParams(
  base: Partial<BacktestConfig>,
  params: Record<string, number | string>,
): BacktestConfig {
  const config: BacktestConfig = {
    strategyName: base.strategyName || 'optimizer',
    pairs: base.pairs || ['BTC/USDT'],
    maxActiveDeals: base.maxActiveDeals || 1,
    initialBalance: base.initialBalance || 10000,
    baseOrderSize: base.baseOrderSize || 1000,
    tradingFee: base.tradingFee ?? 0.1,
    startDate: base.startDate || '',
    endDate: base.endDate || '',
    entryConditions: base.entryConditions || [],
    exitConditions: base.exitConditions || [],
    conditionsActive: base.conditionsActive ?? true,
    stopLossToggle: base.stopLossToggle || false,
    stopLossValue: base.stopLossValue || 0,
    priceChangeActive: base.priceChangeActive || false,
    targetProfit: base.targetProfit || 0,
    safetyOrderToggle: base.safetyOrderToggle || false,
    safetyOrderSize: base.safetyOrderSize || 0,
    maxSafetyOrdersCount: base.maxSafetyOrdersCount || 0,
    priceDeviation: base.priceDeviation || 1,
    safetyOrderVolumeScale: base.safetyOrderVolumeScale || 1,
    safetyOrderStepScale: base.safetyOrderStepScale || 1,
    reinvestProfit: base.reinvestProfit || 0,
    cooldownBetweenDeals: base.cooldownBetweenDeals || 0,
  };

  // Apply each parameter
  for (const [key, value] of Object.entries(params)) {
    const numVal = typeof value === 'number' ? value : parseFloat(value as string);
    const tf = typeof value === 'string' ? value : undefined;

    switch (key) {
      case 'rsiPeriod': {
        // Update RSI Length in entry conditions
        config.entryConditions = config.entryConditions.map((c) =>
          c.indicator === 'RSI'
            ? { ...c, subfields: { ...c.subfields, 'RSI Length': numVal } }
            : c,
        );
        config.exitConditions = (config.exitConditions || []).map((c) =>
          c.indicator === 'RSI'
            ? { ...c, subfields: { ...c.subfields, 'RSI Length': numVal } }
            : c,
        );
        break;
      }
      case 'rsiThreshold': {
        config.entryConditions = config.entryConditions.map((c) =>
          c.indicator === 'RSI'
            ? { ...c, subfields: { ...c.subfields, 'Signal Value': numVal } }
            : c,
        );
        break;
      }
      case 'maFastPeriod': {
        config.entryConditions = config.entryConditions.map((c) =>
          c.indicator === 'MA'
            ? { ...c, subfields: { ...c.subfields, 'Fast MA': numVal } }
            : c,
        );
        break;
      }
      case 'maSlowPeriod': {
        config.entryConditions = config.entryConditions.map((c) =>
          c.indicator === 'MA'
            ? { ...c, subfields: { ...c.subfields, 'Slow MA': numVal } }
            : c,
        );
        break;
      }
      case 'maType': {
        config.entryConditions = config.entryConditions.map((c) =>
          c.indicator === 'MA'
            ? { ...c, subfields: { ...c.subfields, 'MA Type': value } }
            : c,
        );
        break;
      }
      case 'bbPeriod': {
        const updateBB = (c: any) =>
          c.indicator === 'BollingerBands'
            ? { ...c, subfields: { ...c.subfields, 'BB% Period': numVal } }
            : c;
        config.entryConditions = config.entryConditions.map(updateBB);
        config.exitConditions = (config.exitConditions || []).map(updateBB);
        break;
      }
      case 'bbDeviation': {
        const updateDev = (c: any) =>
          c.indicator === 'BollingerBands'
            ? { ...c, subfields: { ...c.subfields, Deviation: numVal } }
            : c;
        config.entryConditions = config.entryConditions.map(updateDev);
        config.exitConditions = (config.exitConditions || []).map(updateDev);
        break;
      }
      case 'bbThreshold': {
        const updateThresh = (c: any) =>
          c.indicator === 'BollingerBands'
            ? { ...c, subfields: { ...c.subfields, 'Signal Value': numVal } }
            : c;
        config.exitConditions = (config.exitConditions || []).map(updateThresh);
        break;
      }
      case 'timeframe': {
        if (tf) {
          const updateTF = (c: any) => ({
            ...c,
            subfields: { ...c.subfields, Timeframe: tf },
          });
          config.entryConditions = config.entryConditions.map(updateTF);
          config.exitConditions = (config.exitConditions || []).map(updateTF);
        }
        break;
      }
      case 'takeProfit':
        config.priceChangeActive = numVal > 0;
        config.targetProfit = numVal;
        break;
      case 'stopLoss':
        config.stopLossToggle = numVal > 0;
        config.stopLossValue = numVal;
        break;
      case 'baseOrderSize':
        config.baseOrderSize = numVal;
        break;
      case 'maxActiveDeals':
        config.maxActiveDeals = numVal;
        break;
      case 'safetyOrdersCount':
        config.safetyOrderToggle = numVal > 0;
        config.maxSafetyOrdersCount = numVal;
        break;
      case 'priceDeviation':
        config.priceDeviation = numVal;
        break;
    }
  }

  return config;
}

// ── Batched parallel execution ───────────────────────────────────────

async function runBatch(
  configs: { id: number; config: BacktestConfig; params: Record<string, number | string> }[],
  goal: OptimizationGoal,
): Promise<OptimizationRun[]> {
  const results = await Promise.all(
    configs.map(async ({ id, config, params }) => {
      const result = await runBacktest(config);
      return {
        id,
        params,
        result,
        score: scoreResult(result, goal),
      };
    }),
  );
  return results;
}

// ── Main Optimizer ───────────────────────────────────────────────────

export async function runOptimizer(
  request: OptimizeRequest,
): Promise<OptimizeResult> {
  const startTime = Date.now();
  const { baseConfig, parameters, goal, maxCombinations = 1000, concurrency = 5 } = request;

  try {
    // Generate all parameter combinations
    const allCombinations = generateCombinations(parameters);
    const combinations = allCombinations.slice(0, maxCombinations);

    if (combinations.length === 0) {
      return {
        status: 'error',
        message: 'No parameter combinations to test.',
        totalCombinations: 0,
        completedRuns: 0,
        failedRuns: 0,
        bestRun: null,
        topRuns: [],
        allRuns: [],
        runtime: Date.now() - startTime,
        goal,
      };
    }

    // Build configs
    const configs = combinations.map((params, idx) => ({
      id: idx + 1,
      params,
      config: applyParams(baseConfig, params),
    }));

    // Run in batches
    const allRuns: OptimizationRun[] = [];
    let failedRuns = 0;

    for (let i = 0; i < configs.length; i += concurrency) {
      const batch = configs.slice(i, i + concurrency);
      const results = await runBatch(batch, goal);

      for (const run of results) {
        if (run.result.status !== 'success') failedRuns++;
        allRuns.push(run);
      }
    }

    // Sort by score (descending)
    allRuns.sort((a, b) => b.score - a.score);

    const topRuns = allRuns.filter((r) => r.score > -Infinity).slice(0, 10);
    const bestRun = topRuns[0] || null;

    return {
      status: 'success',
      message: `Optimization complete. Tested ${allRuns.length} combinations. Best: ${bestRun ? `$${bestRun.result.metrics?.net_profit_usd} net profit` : 'none'}.`,
      totalCombinations: allCombinations.length,
      completedRuns: allRuns.length - failedRuns,
      failedRuns,
      bestRun,
      topRuns,
      allRuns: allRuns.map((r) => ({
        ...r,
        result: {
          ...r.result,
          trades: undefined, // strip trade details for size
          chartData: undefined,
        },
      })),
      runtime: Date.now() - startTime,
      goal,
    };
  } catch (err: any) {
    return {
      status: 'error',
      message: err.message || 'Optimization failed',
      totalCombinations: 0,
      completedRuns: 0,
      failedRuns: 0,
      bestRun: null,
      topRuns: [],
      allRuns: [],
      runtime: Date.now() - startTime,
      goal,
    };
  }
}
