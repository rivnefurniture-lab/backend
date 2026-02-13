/**
 * conditions.ts — Unified condition evaluation for backtest + live trading.
 *
 * This is the SINGLE source of truth for how entry/exit/safety conditions
 * are evaluated.  Both the backtest engine and the live trading service
 * import and use these functions so results are identical.
 */

export interface ConditionSpec {
  indicator: string;
  subfields: Record<string, any>;
}

/**
 * Check a single condition against the current data row.
 *
 * `prevRow` is used for Crossing Up / Crossing Down operators.
 * Timeframe suffixing is NOT done here — the caller must supply
 * the correct column names for the timeframe (the indicator maps
 * are already built per-timeframe by the indicator module).
 */
export function checkCondition(
  row: Record<string, any>,
  prevRow: Record<string, any> | null,
  cond: ConditionSpec,
): boolean {
  const { indicator, subfields } = cond;
  if (!indicator) return false;
  if (indicator === 'IMMEDIATE') return true;
  if (indicator === 'TIME_ELAPSED') return true; // handled externally

  const operator = subfields?.Condition || subfields?.['MACD Trigger'] || 'Greater Than';
  const signalValue = subfields?.['Signal Value'];

  // ── RSI ──
  if (indicator === 'RSI') {
    const period = subfields?.['RSI Length'] || 14;
    const col = `RSI_${period}`;
    const val = row[col];
    if (val == null || isNaN(val)) return false;
    return evalOp(val, signalValue, operator, prevRow?.[col] ?? null, prevRow ? signalValue : null);
  }

  // ── MA (Fast vs Slow) ──
  if (indicator === 'MA') {
    const maType = (subfields?.['MA Type'] || 'SMA').toUpperCase();
    const fast = subfields?.['Fast MA'] || 50;
    const slow = subfields?.['Slow MA'] || 200;
    const fastCol = `${maType}_${fast}`;
    const slowCol = `${maType}_${slow}`;
    const valFast = row[fastCol];
    const valSlow = row[slowCol];
    if (valFast == null || valSlow == null || isNaN(valFast) || isNaN(valSlow))
      return false;

    const prevFast = prevRow?.[fastCol] ?? null;
    const prevSlow = prevRow?.[slowCol] ?? null;

    switch (operator) {
      case 'Less Than':
        return valFast < valSlow;
      case 'Greater Than':
        return valFast > valSlow;
      case 'Crossing Up':
        if (prevFast == null || prevSlow == null) return false;
        return prevFast <= prevSlow && valFast > valSlow;
      case 'Crossing Down':
        if (prevFast == null || prevSlow == null) return false;
        return prevFast >= prevSlow && valFast < valSlow;
      default:
        return false;
    }
  }

  // ── Bollinger Bands %B ──
  if (indicator === 'BollingerBands') {
    const period = subfields?.['BB% Period'] || 20;
    const dev = subfields?.['Deviation'] || 2;
    const col = `BB_%B_${period}_${dev}`;
    const val = row[col];
    if (val == null || isNaN(val)) return false;
    return evalOp(val, signalValue, operator, prevRow?.[col] ?? null, prevRow ? signalValue : null);
  }

  // ── MACD ──
  if (indicator === 'MACD') {
    const preset = subfields?.['MACD Preset'] || '12,26,9';
    const [f, s, sig] = preset.split(',').map(Number);
    const mainCol = `MACD_${f}_${s}_${sig}`;
    const sigCol = `${mainCol}_Signal`;
    const mainVal = row[mainCol];
    const sigVal = row[sigCol];
    if (mainVal == null || sigVal == null || isNaN(mainVal) || isNaN(sigVal))
      return false;

    // MACD Trigger (crossover of MACD line vs signal line)
    const macdTrigger = subfields?.['MACD Trigger'] || '';
    if (macdTrigger === 'Crossing Up') {
      const prevMain = prevRow?.[mainCol];
      const prevSig = prevRow?.[sigCol];
      if (prevMain == null || prevSig == null) return false;
      if (!(prevMain <= prevSig && mainVal > sigVal)) return false;
    } else if (macdTrigger === 'Crossing Down') {
      const prevMain = prevRow?.[mainCol];
      const prevSig = prevRow?.[sigCol];
      if (prevMain == null || prevSig == null) return false;
      if (!(prevMain >= prevSig && mainVal < sigVal)) return false;
    }

    // Line Trigger (above/below zero)
    const lineTrigger = subfields?.['Line Trigger'] || '';
    if (lineTrigger === 'Less Than 0' && mainVal >= 0) return false;
    if (lineTrigger === 'Greater Than 0' && mainVal <= 0) return false;

    return true;
  }

  // ── Stochastic ──
  if (indicator === 'Stochastic') {
    const preset = subfields?.['Stochastic Preset'] || '14,3,3';
    const [kP, ks, ds] = preset.split(',').map(Number);
    const kCol = `Stochastic_K_${kP}_${ks}`;
    const dCol = `Stochastic_D_${kP}_${ks}_${ds}`;
    const kVal = row[kCol];
    const dVal = row[dCol];
    if (kVal == null || isNaN(kVal)) return false;

    // K value conditions
    const kCond = subfields?.['K Condition'] || '';
    const kSigVal = subfields?.['K Signal Value'];
    if (kCond) {
      if (!evalOp(kVal, kSigVal, kCond, prevRow?.[kCol] ?? null, prevRow ? kSigVal : null))
        return false;
    }

    // K vs D crossing
    const mainCond = subfields?.Condition || '';
    if (mainCond === 'K Crossing Up D') {
      if (dVal == null) return false;
      const prevK = prevRow?.[kCol];
      const prevD = prevRow?.[dCol];
      if (prevK == null || prevD == null) return false;
      if (!(prevK <= prevD && kVal > dVal)) return false;
    } else if (mainCond === 'K Crossing Down D') {
      if (dVal == null) return false;
      const prevK = prevRow?.[kCol];
      const prevD = prevRow?.[dCol];
      if (prevK == null || prevD == null) return false;
      if (!(prevK >= prevD && kVal < dVal)) return false;
    }

    return true;
  }

  // ── Parabolic SAR ──
  if (indicator === 'ParabolicSAR') {
    const preset = subfields?.['PSAR Preset'] || '0.02,0.2';
    const [stepStr, maxStr] = preset.split(',');
    const col = `PSAR_AF_${stepStr}_Max_${maxStr}`;
    const val = row[col];
    if (val == null || isNaN(val)) return false;

    if (operator === 'Crossing (Long)' || operator === 'Crossing (Short)') {
      if (!prevRow) return false;
      const prevVal = prevRow[col];
      const closeNow = row.close;
      const closePrev = prevRow.close;
      if (prevVal == null || closeNow == null || closePrev == null) return false;

      if (operator === 'Crossing (Long)') {
        return closePrev <= prevVal && closeNow > val;
      } else {
        return closePrev >= prevVal && closeNow < val;
      }
    }

    return evalOp(val, signalValue, operator, null, null);
  }

  // Unknown indicator
  return false;
}

/**
 * Evaluate a comparison operator.
 * For Crossing Up/Down, prevVal and prevCompare must be provided.
 */
function evalOp(
  currentValue: number,
  compareValue: number | null | undefined,
  operator: string,
  prevValue: number | null,
  prevCompare: number | null | undefined,
): boolean {
  if (compareValue == null) return false;

  switch (operator) {
    case 'Less Than':
      return currentValue < compareValue;
    case 'Greater Than':
      return currentValue > compareValue;
    case 'Crossing Up':
      if (prevValue == null || prevCompare == null) return false;
      return prevValue <= prevCompare && currentValue > compareValue;
    case 'Crossing Down':
      if (prevValue == null || prevCompare == null) return false;
      return prevValue >= prevCompare && currentValue < compareValue;
    default:
      return false;
  }
}

/**
 * Check ALL conditions (AND logic). Returns true only if every condition passes.
 */
export function checkAllConditions(
  row: Record<string, any>,
  prevRow: Record<string, any> | null,
  conditions: ConditionSpec[],
): boolean {
  if (!conditions || conditions.length === 0) return false;

  for (const cond of conditions) {
    if (cond.indicator === 'IMMEDIATE') return true;
    if (cond.indicator === 'TIME_ELAPSED') continue;
    if (!checkCondition(row, prevRow, cond)) return false;
  }
  return true;
}
