/**
 * indicators.ts — Unified indicator calculation for backtest + live trading.
 *
 * Uses the `technicalindicators` library to compute RSI, SMA, EMA, MACD,
 * Bollinger %B, Stochastic, and Parabolic SAR from raw OHLCV candles.
 *
 * Each function returns an array the same length as the input (padded with
 * NaN at the start where there isn't enough data yet).
 */

import {
  RSI,
  SMA,
  EMA,
  MACD,
  BollingerBands,
  Stochastic,
} from 'technicalindicators';

export interface Candle {
  timestamp: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Pad result array at the front so it aligns with source length */
function padFront(values: number[], targetLen: number): number[] {
  const pad = targetLen - values.length;
  if (pad <= 0) return values;
  return [...Array(pad).fill(NaN), ...values];
}

// ── RSI ──────────────────────────────────────────────────────────────
export function calcRSI(closes: number[], period: number): number[] {
  const result = RSI.calculate({ values: closes, period });
  return padFront(result, closes.length);
}

// ── SMA ──────────────────────────────────────────────────────────────
export function calcSMA(closes: number[], period: number): number[] {
  const result = SMA.calculate({ values: closes, period });
  return padFront(result, closes.length);
}

// ── EMA ──────────────────────────────────────────────────────────────
export function calcEMA(closes: number[], period: number): number[] {
  const result = EMA.calculate({ values: closes, period });
  return padFront(result, closes.length);
}

// ── MACD ─────────────────────────────────────────────────────────────
export interface MACDRow {
  macd: number;
  signal: number;
  histogram: number;
}

export function calcMACD(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MACDRow[] {
  const raw = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const pad = closes.length - raw.length;
  const nanRow: MACDRow = { macd: NaN, signal: NaN, histogram: NaN };
  const padded: MACDRow[] = Array(pad).fill(nanRow);
  return [
    ...padded,
    ...raw.map((r) => ({
      macd: r.MACD ?? NaN,
      signal: r.signal ?? NaN,
      histogram: r.histogram ?? NaN,
    })),
  ];
}

// ── Bollinger Bands %B ───────────────────────────────────────────────
export function calcBollingerPctB(
  closes: number[],
  period: number,
  stdDev: number,
): number[] {
  const raw = BollingerBands.calculate({
    values: closes,
    period,
    stdDev,
  });
  const pctB = raw.map((r) => {
    const range = r.upper - r.lower;
    return range > 0 ? (closes[closes.length - raw.length + raw.indexOf(r)] - r.lower) / range : 0.5;
  });
  // Recompute more carefully
  const result: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const idx = closes.length - raw.length + i;
    const range = raw[i].upper - raw[i].lower;
    result.push(range > 0 ? (closes[idx] - raw[i].lower) / range : 0.5);
  }
  return padFront(result, closes.length);
}

// ── Stochastic ───────────────────────────────────────────────────────
export interface StochRow {
  k: number;
  d: number;
}

export function calcStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number,
  kSmooth: number,
  dSmooth: number,
): StochRow[] {
  const raw = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: kPeriod,
    signalPeriod: dSmooth,
  });
  const pad = closes.length - raw.length;
  const nanRow: StochRow = { k: NaN, d: NaN };
  return [
    ...Array(pad).fill(nanRow),
    ...raw.map((r) => ({ k: r.k, d: r.d })),
  ];
}

// ── Parabolic SAR ────────────────────────────────────────────────────
export function calcPSAR(
  highs: number[],
  lows: number[],
  step: number,
  max: number,
): number[] {
  // Manual PSAR implementation (technicalindicators doesn't include one)
  const len = highs.length;
  if (len < 2) return Array(len).fill(NaN);

  const sar: number[] = new Array(len).fill(NaN);
  let isLong = highs[1] > highs[0];
  let af = step;
  let ep = isLong ? highs[0] : lows[0];
  sar[0] = isLong ? lows[0] : highs[0];

  for (let i = 1; i < len; i++) {
    const prevSar = sar[i - 1];
    let newSar = prevSar + af * (ep - prevSar);

    if (isLong) {
      newSar = Math.min(newSar, lows[i - 1]);
      if (i >= 2) newSar = Math.min(newSar, lows[i - 2]);
      if (lows[i] < newSar) {
        // Flip to short
        isLong = false;
        newSar = ep;
        ep = lows[i];
        af = step;
      } else {
        if (highs[i] > ep) {
          ep = highs[i];
          af = Math.min(af + step, max);
        }
      }
    } else {
      newSar = Math.max(newSar, highs[i - 1]);
      if (i >= 2) newSar = Math.max(newSar, highs[i - 2]);
      if (highs[i] > newSar) {
        // Flip to long
        isLong = true;
        newSar = ep;
        ep = highs[i];
        af = step;
      } else {
        if (lows[i] < ep) {
          ep = lows[i];
          af = Math.min(af + step, max);
        }
      }
    }
    sar[i] = newSar;
  }
  return sar;
}

// ── Build indicator map for a set of candles ─────────────────────────

export interface IndicatorSpec {
  indicator: string;
  subfields: Record<string, any>;
}

/**
 * Pre-compute every indicator referenced by the given conditions on a
 * candle array and return a per-bar record keyed by column name.
 *
 * The returned array has the same length as `candles`.
 */
export function buildIndicatorMaps(
  candles: Candle[],
  conditions: IndicatorSpec[],
): Record<string, number>[] {
  const len = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // Collect unique calculations needed
  const computed: Record<string, number[]> = {};

  const ensure = (key: string, fn: () => number[]) => {
    if (!computed[key]) computed[key] = fn();
  };

  for (const cond of conditions) {
    const { indicator, subfields } = cond;
    if (!indicator || indicator === 'IMMEDIATE' || indicator === 'TIME_ELAPSED')
      continue;

    if (indicator === 'RSI') {
      const period = subfields?.['RSI Length'] || 14;
      ensure(`RSI_${period}`, () => calcRSI(closes, period));
    } else if (indicator === 'MA') {
      const maType = (subfields?.['MA Type'] || 'SMA').toUpperCase();
      const fast = subfields?.['Fast MA'] || 50;
      const slow = subfields?.['Slow MA'] || 200;
      const calc = maType === 'EMA' ? calcEMA : calcSMA;
      ensure(`${maType}_${fast}`, () => calc(closes, fast));
      ensure(`${maType}_${slow}`, () => calc(closes, slow));
    } else if (indicator === 'BollingerBands') {
      const period = subfields?.['BB% Period'] || 20;
      const dev = subfields?.['Deviation'] || 2;
      ensure(`BB_%B_${period}_${dev}`, () =>
        calcBollingerPctB(closes, period, dev),
      );
    } else if (indicator === 'MACD') {
      const preset = subfields?.['MACD Preset'] || '12,26,9';
      const [f, s, sig] = preset.split(',').map(Number);
      const key = `MACD_${f}_${s}_${sig}`;
      if (!computed[key]) {
        const rows = calcMACD(closes, f, s, sig);
        computed[key] = rows.map((r) => r.macd);
        computed[`${key}_Signal`] = rows.map((r) => r.signal);
      }
    } else if (indicator === 'Stochastic') {
      const preset = subfields?.['Stochastic Preset'] || '14,3,3';
      const [k, ks, ds] = preset.split(',').map(Number);
      const kKey = `Stochastic_K_${k}_${ks}`;
      const dKey = `Stochastic_D_${k}_${ks}_${ds}`;
      if (!computed[kKey]) {
        const rows = calcStochastic(highs, lows, closes, k, ks, ds);
        computed[kKey] = rows.map((r) => r.k);
        computed[dKey] = rows.map((r) => r.d);
      }
    } else if (indicator === 'ParabolicSAR') {
      const preset = subfields?.['PSAR Preset'] || '0.02,0.2';
      const [stepVal, maxVal] = preset.split(',').map(Number);
      ensure(`PSAR_AF_${stepVal}_Max_${maxVal}`, () =>
        calcPSAR(highs, lows, stepVal, maxVal),
      );
    }
  }

  // Build per-bar records
  const records: Record<string, number>[] = [];
  for (let i = 0; i < len; i++) {
    const rec: Record<string, number> = {
      close: closes[i],
      high: highs[i],
      low: lows[i],
      open: candles[i].open,
      volume: candles[i].volume,
    };
    for (const [key, arr] of Object.entries(computed)) {
      rec[key] = arr[i];
    }
    records.push(rec);
  }
  return records;
}
