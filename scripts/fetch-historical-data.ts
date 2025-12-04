/**
 * Historical Data Fetcher
 * 
 * Run this locally to fetch 3 years of historical data for all pairs.
 * This will take several hours but only needs to be done once.
 * 
 * Usage: npx ts-node scripts/fetch-historical-data.ts
 */

import * as ccxt from 'ccxt';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
  'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'NEAR/USDT',
  'LTC/USDT', 'HBAR/USDT', 'SUI/USDT', 'TRX/USDT', 'BCH/USDT',
  'RENDER/USDT', 'ATOM/USDT'
];

// We'll fetch 1h and 4h timeframes (1m would be too much data)
const TIMEFRAMES = ['1h', '4h', '1d'];

// 3 years back
const YEARS_BACK = 3;

// Data directory
const DATA_DIR = path.join(__dirname, '..', 'data', 'ohlcv');

interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSymbolData(
  exchange: ccxt.Exchange,
  symbol: string,
  timeframe: string,
  startDate: Date,
  endDate: Date
): Promise<OHLCV[]> {
  const allData: OHLCV[] = [];
  let currentSince = startDate.getTime();
  const limit = 1000;
  let retries = 0;
  const maxRetries = 5;

  console.log(`  Fetching ${symbol} ${timeframe}...`);

  while (currentSince < endDate.getTime()) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, limit);

      if (!ohlcv || ohlcv.length === 0) break;

      for (const candle of ohlcv) {
        const timestamp = candle[0] as number;
        if (timestamp > endDate.getTime()) break;

        allData.push({
          timestamp,
          open: candle[1] as number,
          high: candle[2] as number,
          low: candle[3] as number,
          close: candle[4] as number,
          volume: candle[5] as number,
        });
      }

      const lastTimestamp = ohlcv[ohlcv.length - 1][0] as number;
      if (lastTimestamp <= currentSince) break;
      currentSince = lastTimestamp + 1;

      // Progress indicator
      const progress = ((currentSince - startDate.getTime()) / (endDate.getTime() - startDate.getTime()) * 100).toFixed(1);
      process.stdout.write(`\r  ${symbol} ${timeframe}: ${allData.length} candles (${progress}%)`);

      // Rate limiting - be nice to the API
      await sleep(100);
      retries = 0;

    } catch (error: any) {
      retries++;
      console.error(`\n  Error fetching ${symbol} ${timeframe}: ${error.message}`);
      
      if (retries >= maxRetries) {
        console.error(`  Max retries reached, moving on...`);
        break;
      }
      
      // Wait longer on error
      await sleep(5000 * retries);
    }
  }

  console.log(`\n  ✓ ${symbol} ${timeframe}: ${allData.length} candles`);
  return allData;
}

function calculateIndicators(data: OHLCV[]): any[] {
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);

  // Pre-calculate common indicators
  const rsi14 = calculateRSI(closes, 14);
  const rsi21 = calculateRSI(closes, 21);
  const rsi28 = calculateRSI(closes, 28);
  
  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const sma100 = calculateSMA(closes, 100);
  const sma200 = calculateSMA(closes, 200);
  
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema100 = calculateEMA(closes, 100);
  const ema200 = calculateEMA(closes, 200);
  
  const bb20_2 = calculateBollingerBands(closes, 20, 2);
  const bb20_1 = calculateBollingerBands(closes, 20, 1);
  
  const macd = calculateMACD(closes, 12, 26, 9);

  return data.map((candle, i) => ({
    ...candle,
    // RSI
    RSI_14: rsi14[i],
    RSI_21: rsi21[i],
    RSI_28: rsi28[i],
    // SMA
    SMA_20: sma20[i],
    SMA_50: sma50[i],
    SMA_100: sma100[i],
    SMA_200: sma200[i],
    // EMA
    EMA_20: ema20[i],
    EMA_50: ema50[i],
    EMA_100: ema100[i],
    EMA_200: ema200[i],
    // Bollinger Bands
    BB_20_2: bb20_2[i],
    BB_20_1: bb20_1[i],
    // MACD
    MACD_line: macd.line[i],
    MACD_signal: macd.signal[i],
    MACD_hist: macd.hist[i],
  }));
}

function calculateRSI(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);
  
  const rsi: (number | null)[] = new Array(period).fill(null);
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-9)));
  
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-9)));
  }
  
  return rsi as number[];
}

function calculateSMA(values: number[], period: number): (number | null)[] {
  const sma: (number | null)[] = new Array(period - 1).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    sma.push(values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return sma;
}

function calculateEMA(values: number[], period: number): (number | null)[] {
  if (values.length < period) return new Array(values.length).fill(null);
  
  const ema: (number | null)[] = new Array(period - 1).fill(null);
  const multiplier = 2 / (period + 1);
  
  ema.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
  
  for (let i = period; i < values.length; i++) {
    const prevEma = ema[ema.length - 1] as number;
    ema.push((values[i] - prevEma) * multiplier + prevEma);
  }
  
  return ema;
}

function calculateBollingerBands(closes: number[], period: number, deviation: number): (number | null)[] {
  const sma = calculateSMA(closes, period);
  const bb: (number | null)[] = new Array(period - 1).fill(null);
  
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = sma[i] as number;
    const stdDev = Math.sqrt(slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period);
    
    const upper = mean + deviation * stdDev;
    const lower = mean - deviation * stdDev;
    bb.push((closes[i] - lower) / ((upper - lower) || 1));
  }
  
  return bb;
}

function calculateMACD(closes: number[], fast: number, slow: number, signal: number) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  
  const line = emaFast.map((f, i) => 
    f === null || emaSlow[i] === null ? null : (f as number) - (emaSlow[i] as number)
  );
  
  const validLine = line.filter(v => v !== null) as number[];
  const signalValues = calculateEMA(validLine, signal);
  
  const signalLine: (number | null)[] = new Array(line.length - validLine.length).fill(null);
  signalLine.push(...signalValues);
  
  const hist = line.map((l, i) => 
    l === null || signalLine[i] === null ? null : l - (signalLine[i] as number)
  );
  
  return { line, signal: signalLine, hist };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Historical Data Fetcher for Algotcha');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Symbols: ${SYMBOLS.length}`);
  console.log(`Timeframes: ${TIMEFRAMES.join(', ')}`);
  console.log(`Period: ${YEARS_BACK} years`);
  console.log('');

  // Create data directory
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Created directory: ${DATA_DIR}`);
  }

  // Initialize exchange
  const exchange = new ccxt.binance({ enableRateLimit: true });
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - YEARS_BACK);
  
  console.log(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log('');

  let totalFiles = 0;
  const startTime = Date.now();

  for (const symbol of SYMBOLS) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Processing ${symbol}...`);
    console.log(`${'─'.repeat(50)}`);

    for (const timeframe of TIMEFRAMES) {
      try {
        // Fetch data
        const rawData = await fetchSymbolData(exchange, symbol, timeframe, startDate, endDate);
        
        if (rawData.length === 0) {
          console.log(`  ⚠ No data for ${symbol} ${timeframe}`);
          continue;
        }

        // Calculate indicators
        console.log(`  Calculating indicators...`);
        const dataWithIndicators = calculateIndicators(rawData);

        // Save to file
        const filename = `${symbol.replace('/', '_')}_${timeframe}.json`;
        const filepath = path.join(DATA_DIR, filename);
        
        fs.writeFileSync(filepath, JSON.stringify(dataWithIndicators));
        
        const fileSizeMB = (fs.statSync(filepath).size / (1024 * 1024)).toFixed(2);
        console.log(`  💾 Saved: ${filename} (${fileSizeMB} MB, ${dataWithIndicators.length} candles)`);
        
        totalFiles++;

        // Small delay between timeframes
        await sleep(500);
        
      } catch (error: any) {
        console.error(`  ❌ Failed ${symbol} ${timeframe}: ${error.message}`);
      }
    }

    // Delay between symbols
    await sleep(1000);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  console.log('\n');
  console.log('='.repeat(60));
  console.log('COMPLETED!');
  console.log('='.repeat(60));
  console.log(`Total files: ${totalFiles}`);
  console.log(`Time elapsed: ${elapsed} minutes`);
  console.log(`Data location: ${DATA_DIR}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Commit the data folder to git');
  console.log('2. Push to GitHub');
  console.log('3. Railway will use this pre-fetched data');
}

main().catch(console.error);

