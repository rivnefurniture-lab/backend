/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
function rsi(values: string | any[], period = 14) {
  if (values.length < period + 1) return [];
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let rs = gains / (losses || 1e-9);
  const out = [100 - 100 / (1 + rs)];
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0),
      loss = Math.max(-diff, 0);
    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    rs = gains / (losses || 1e-9);
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

export async function rsiMeanReversion({
  exchange,
  symbol,
  timeframe = '1m',
  amountUSDT = 50,
  logger,
}) {
  await exchange.loadMarkets();
  const market = exchange.market(symbol);
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 200);
  const closes = ohlcv.map((x) => x[4]);
  const r = rsi(closes, 14);
  const currentRSI = r[r.length - 1];
  const last = ohlcv[ohlcv.length - 1][4];
  logger(`Last price ${symbol}: ${last}, RSI=${currentRSI?.toFixed(2)}`);
  const balances = await exchange.fetchBalance();
  const base = market.base,
    quote = market.quote;
  const baseBal = balances.total?.[base] || 0;
  const quoteBal = balances.total?.[quote] || 0;
  if (
    currentRSI !== undefined &&
    currentRSI < 30 &&
    quoteBal * 1 > amountUSDT * 0.9
  ) {
    const amountBase = amountUSDT / last;
    const amt = exchange.amountToPrecision(symbol, amountBase);
    logger(`BUY market ${symbol} amount ${amt} (≈$${amountUSDT})`);
    const order = await exchange.createOrder(symbol, 'market', 'buy', amt);
    logger(`BUY executed: ${order.id || 'id?'} filled=${order.filled}`);
    return { side: 'buy', order };
  } else if (
    currentRSI !== undefined &&
    currentRSI > 70 &&
    baseBal * last > 10
  ) {
    const amt = exchange.amountToPrecision(symbol, baseBal);
    logger(`SELL market ${symbol} amount ${amt}`);
    const order = await exchange.createOrder(symbol, 'market', 'sell', amt);
    logger(`SELL executed: ${order.id || 'id?'} filled=${order.filled}`);
    return { side: 'sell', order };
  } else {
    logger('No trade condition met.');
    return { side: 'none' };
  }
}
