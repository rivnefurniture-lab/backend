// src/modules/backtest/data-fetcher.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as ccxt from 'ccxt';
import * as fs from 'fs';
import * as path from 'path';

export interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorValues {
  // RSI for multiple periods
  RSI_7: number;
  RSI_14: number;
  RSI_21: number;
  RSI_28: number;
  // SMAs
  SMA_10: number;
  SMA_20: number;
  SMA_50: number;
  SMA_100: number;
  SMA_200: number;
  // EMAs
  EMA_10: number;
  EMA_20: number;
  EMA_50: number;
  EMA_100: number;
  EMA_200: number;
  // Bollinger Bands %B
  BB_pctB_20_2: number;
  BB_pctB_20_1: number;
  BB_pctB_50_2: number;
  // MACD
  MACD_12_26_9: number;
  MACD_12_26_9_signal: number;
  MACD_12_26_9_hist: number;
  // Stochastic
  Stoch_K_14_3: number;
  Stoch_D_14_3_3: number;
}

export interface CandleWithIndicators extends OHLCV, Partial<IndicatorValues> {
  symbol: string;
  timeframe: string;
}

@Injectable()
export class DataFetcherService implements OnModuleInit {
  private readonly logger = new Logger(DataFetcherService.name);
  private exchange: ccxt.Exchange;
  private dataCache: Map<string, CandleWithIndicators[]> = new Map();
  private lastFetchTime: Map<string, Date> = new Map();
  
  // Data directory for persistent storage
  private readonly DATA_DIR = path.join(process.cwd(), 'data', 'ohlcv');
  
  // Supported symbols
  private readonly SYMBOLS = [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
    'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'NEAR/USDT',
    'LTC/USDT', 'HBAR/USDT', 'SUI/USDT', 'TRX/USDT', 'BCH/USDT',
    'RENDER/USDT', 'ATOM/USDT'
  ];

  // Timeframes to fetch
  private readonly TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

  constructor() {
    this.exchange = new ccxt.binance({
      enableRateLimit: true,
    });
    
    // Ensure data directory exists
    if (!fs.existsSync(this.DATA_DIR)) {
      fs.mkdirSync(this.DATA_DIR, { recursive: true });
    }
  }

  async onModuleInit() {
    this.logger.log('Data Fetcher Service initialized');
    // Load cached data from disk
    await this.loadCachedData();
    // Start initial fetch after a delay
    setTimeout(() => this.fetchAllHistoricalData(), 5000);
  }

  // Fetch data every minute
  @Cron('0 * * * * *') // Every minute at :00
  async handleMinuteFetch() {
    this.logger.log('Minute data update triggered');
    await this.updateLatestCandles();
  }

  // Full historical data refresh every 6 hours
  @Cron('0 0 */6 * * *')
  async handleHistoricalRefresh() {
    this.logger.log('Full historical data refresh triggered');
    await this.fetchAllHistoricalData();
  }

  // Load cached data from disk
  private async loadCachedData() {
    try {
      const files = fs.readdirSync(this.DATA_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const key = file.replace('.json', '');
          const filePath = path.join(this.DATA_DIR, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          
          // Convert timestamps back to Date objects
          const candles = data.map((c: any) => ({
            ...c,
            timestamp: new Date(c.timestamp)
          }));
          
          this.dataCache.set(key, candles);
          this.logger.log(`Loaded ${candles.length} candles for ${key}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to load cached data: ${error.message}`);
    }
  }

  // Save data to disk
  private saveDataToDisk(symbol: string, timeframe: string, data: CandleWithIndicators[]) {
    const key = `${symbol.replace('/', '_')}_${timeframe}`;
    const filePath = path.join(this.DATA_DIR, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  // Fetch all historical data (3 years)
  async fetchAllHistoricalData() {
    this.logger.log('Starting full historical data fetch for all symbols...');
    
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    
    for (const symbol of this.SYMBOLS) {
      for (const timeframe of this.TIMEFRAMES) {
        try {
          const key = `${symbol.replace('/', '_')}_${timeframe}`;
          
          // Check if we already have recent data
          const lastFetch = this.lastFetchTime.get(key);
          if (lastFetch && (Date.now() - lastFetch.getTime()) < 60 * 60 * 1000) {
            continue; // Skip if fetched within last hour
          }
          
          this.logger.log(`Fetching ${symbol} ${timeframe}...`);
          const data = await this.fetchHistoricalData(symbol, timeframe, threeYearsAgo, new Date());
          
          if (data.length > 0) {
            // Calculate indicators
            const withIndicators = this.calculateAllIndicators(data, symbol, timeframe);
            this.dataCache.set(key, withIndicators);
            this.saveDataToDisk(symbol, timeframe, withIndicators);
            this.lastFetchTime.set(key, new Date());
            
            this.logger.log(`✓ Fetched ${data.length} candles for ${symbol} ${timeframe}`);
          }
          
          // Rate limiting - wait between requests
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          this.logger.error(`Failed to fetch ${symbol} ${timeframe}: ${error.message}`);
        }
      }
    }
    
    this.logger.log('Historical data fetch completed');
  }

  // Update only the latest candles (for minute-by-minute updates)
  async updateLatestCandles() {
    for (const symbol of this.SYMBOLS) {
      for (const timeframe of this.TIMEFRAMES) {
        try {
          const key = `${symbol.replace('/', '_')}_${timeframe}`;
          const existingData = this.dataCache.get(key) || [];
          
          // Fetch last 10 candles to update
          const limit = 10;
          const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
          
          if (!ohlcv || ohlcv.length === 0) continue;
          
          const newCandles: CandleWithIndicators[] = ohlcv.map(c => ({
            timestamp: new Date(c[0] as number),
            open: c[1] as number,
            high: c[2] as number,
            low: c[3] as number,
            close: c[4] as number,
            volume: c[5] as number,
            symbol,
            timeframe
          }));
          
          // Merge with existing data
          const mergedData = this.mergeCandles(existingData, newCandles);
          
          // Recalculate indicators for the entire dataset
          const withIndicators = this.calculateAllIndicators(mergedData, symbol, timeframe);
          
          this.dataCache.set(key, withIndicators);
          this.saveDataToDisk(symbol, timeframe, withIndicators);
          
        } catch (error) {
          this.logger.error(`Failed to update ${symbol} ${timeframe}: ${error.message}`);
        }
      }
    }
  }

  // Merge new candles with existing data
  private mergeCandles(existing: CandleWithIndicators[], newCandles: CandleWithIndicators[]): CandleWithIndicators[] {
    const map = new Map<string, CandleWithIndicators>();
    
    for (const candle of existing) {
      map.set(candle.timestamp.toISOString(), candle);
    }
    
    for (const candle of newCandles) {
      map.set(candle.timestamp.toISOString(), candle);
    }
    
    return Array.from(map.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Fetch historical data from exchange
  async fetchHistoricalData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<CandleWithIndicators[]> {
    const allData: CandleWithIndicators[] = [];
    let currentSince = startDate.getTime();
    const limit = 1000;
    
    while (currentSince < endDate.getTime()) {
      try {
        const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, currentSince, limit);
        
        if (!ohlcv || ohlcv.length === 0) break;
        
        for (const candle of ohlcv) {
          const timestamp = new Date(candle[0] as number);
          if (timestamp > endDate) break;
          
          allData.push({
            timestamp,
            open: candle[1] as number,
            high: candle[2] as number,
            low: candle[3] as number,
            close: candle[4] as number,
            volume: candle[5] as number,
            symbol,
            timeframe
          });
        }
        
        const lastTimestamp = ohlcv[ohlcv.length - 1][0] as number;
        if (lastTimestamp <= currentSince) break;
        currentSince = lastTimestamp + 1;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.error(`Error fetching ${symbol} ${timeframe}: ${error.message}`);
        break;
      }
    }
    
    return allData;
  }

  // Get data from cache
  getData(symbol: string, timeframe: string): CandleWithIndicators[] {
    const key = `${symbol.replace('/', '_')}_${timeframe}`;
    return this.dataCache.get(key) || [];
  }

  // Get data for a specific date range
  getDataInRange(symbol: string, timeframe: string, startDate: Date, endDate: Date): CandleWithIndicators[] {
    const data = this.getData(symbol, timeframe);
    return data.filter(c => c.timestamp >= startDate && c.timestamp <= endDate);
  }

  // Get list of available symbols with data
  getAvailableSymbols(): string[] {
    return this.SYMBOLS.filter(symbol => {
      const key = `${symbol.replace('/', '_')}_1h`;
      return this.dataCache.has(key) && this.dataCache.get(key)!.length > 0;
    });
  }

  // Calculate all indicators for a dataset
  private calculateAllIndicators(
    data: CandleWithIndicators[],
    symbol: string,
    timeframe: string
  ): CandleWithIndicators[] {
    if (data.length === 0) return data;
    
    const closes = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);
    
    // Pre-calculate all indicators
    const rsi7 = this.calculateRSI(closes, 7);
    const rsi14 = this.calculateRSI(closes, 14);
    const rsi21 = this.calculateRSI(closes, 21);
    const rsi28 = this.calculateRSI(closes, 28);
    
    const sma10 = this.calculateSMA(closes, 10);
    const sma20 = this.calculateSMA(closes, 20);
    const sma50 = this.calculateSMA(closes, 50);
    const sma100 = this.calculateSMA(closes, 100);
    const sma200 = this.calculateSMA(closes, 200);
    
    const ema10 = this.calculateEMA(closes, 10);
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    const ema100 = this.calculateEMA(closes, 100);
    const ema200 = this.calculateEMA(closes, 200);
    
    const bb_20_2 = this.calculateBollingerBands(closes, 20, 2);
    const bb_20_1 = this.calculateBollingerBands(closes, 20, 1);
    const bb_50_2 = this.calculateBollingerBands(closes, 50, 2);
    
    const macd = this.calculateMACD(closes, 12, 26, 9);
    
    const stoch = this.calculateStochastic(highs, lows, closes, 14, 3, 3);
    
    // Assign indicators to each candle
    return data.map((candle, i) => ({
      ...candle,
      symbol,
      timeframe,
      RSI_7: rsi7[i],
      RSI_14: rsi14[i],
      RSI_21: rsi21[i],
      RSI_28: rsi28[i],
      SMA_10: sma10[i],
      SMA_20: sma20[i],
      SMA_50: sma50[i],
      SMA_100: sma100[i],
      SMA_200: sma200[i],
      EMA_10: ema10[i],
      EMA_20: ema20[i],
      EMA_50: ema50[i],
      EMA_100: ema100[i],
      EMA_200: ema200[i],
      BB_pctB_20_2: bb_20_2[i],
      BB_pctB_20_1: bb_20_1[i],
      BB_pctB_50_2: bb_50_2[i],
      MACD_12_26_9: macd.line[i],
      MACD_12_26_9_signal: macd.signal[i],
      MACD_12_26_9_hist: macd.hist[i],
      Stoch_K_14_3: stoch.k[i],
      Stoch_D_14_3_3: stoch.d[i],
    }));
  }

  // ============ INDICATOR CALCULATIONS ============
  
  private calculateRSI(closes: number[], period: number): number[] {
    if (closes.length < period + 1) return new Array(closes.length).fill(NaN);
    
    const rsi: number[] = new Array(period).fill(NaN);
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgGain / (avgLoss || 1e-9);
    rsi.push(100 - 100 / (1 + rs));
    
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = Math.max(diff, 0);
      const loss = Math.max(-diff, 0);
      
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rs = avgGain / (avgLoss || 1e-9);
      rsi.push(100 - 100 / (1 + rs));
    }
    
    return rsi;
  }

  private calculateSMA(values: number[], period: number): number[] {
    const sma: number[] = new Array(period - 1).fill(NaN);
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    return sma;
  }

  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) return new Array(values.length).fill(NaN);
    
    const ema: number[] = new Array(period - 1).fill(NaN);
    const multiplier = 2 / (period + 1);
    
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    ema.push(sum / period);
    
    for (let i = period; i < values.length; i++) {
      ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    
    return ema;
  }

  private calculateBollingerBands(closes: number[], period: number, deviation: number): number[] {
    const sma = this.calculateSMA(closes, period);
    const bbPercent: number[] = new Array(period - 1).fill(NaN);
    
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = sma[i];
      const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      
      const upperBand = mean + deviation * stdDev;
      const lowerBand = mean - deviation * stdDev;
      
      const percentB = (closes[i] - lowerBand) / ((upperBand - lowerBand) || 1);
      bbPercent.push(percentB);
    }
    
    return bbPercent;
  }

  private calculateMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
    const emaFast = this.calculateEMA(closes, fast);
    const emaSlow = this.calculateEMA(closes, slow);
    
    const macdLine: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) {
        macdLine.push(NaN);
      } else {
        macdLine.push(emaFast[i] - emaSlow[i]);
      }
    }
    
    // Calculate signal line from valid MACD values
    const validMacd = macdLine.filter(v => !isNaN(v));
    const signalLineValues = this.calculateEMA(validMacd, signal);
    
    // Align signal line with MACD
    const signalLine: number[] = new Array(macdLine.length - validMacd.length).fill(NaN);
    signalLine.push(...signalLineValues);
    
    // Calculate histogram
    const histogram: number[] = [];
    for (let i = 0; i < macdLine.length; i++) {
      if (isNaN(macdLine[i]) || isNaN(signalLine[i])) {
        histogram.push(NaN);
      } else {
        histogram.push(macdLine[i] - signalLine[i]);
      }
    }
    
    return { line: macdLine, signal: signalLine, hist: histogram };
  }

  private calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    kPeriod: number,
    kSmooth: number,
    dSmooth: number
  ) {
    const rawK: number[] = new Array(kPeriod - 1).fill(NaN);
    
    for (let i = kPeriod - 1; i < closes.length; i++) {
      const periodHighs = highs.slice(i - kPeriod + 1, i + 1);
      const periodLows = lows.slice(i - kPeriod + 1, i + 1);
      
      const highest = Math.max(...periodHighs);
      const lowest = Math.min(...periodLows);
      
      const k = ((closes[i] - lowest) / (highest - lowest || 1)) * 100;
      rawK.push(k);
    }
    
    // Smooth K
    const k = this.calculateSMA(rawK, kSmooth);
    
    // Calculate D (SMA of K)
    const d = this.calculateSMA(k, dSmooth);
    
    return { k, d };
  }

  // Get indicator value at a specific index
  getIndicatorValue(
    symbol: string,
    timeframe: string,
    indicator: string,
    period: number,
    index: number
  ): number | null {
    const data = this.getData(symbol, timeframe);
    if (index < 0 || index >= data.length) return null;
    
    const candle = data[index];
    const key = `${indicator}_${period}` as keyof IndicatorValues;
    
    if (key in candle) {
      return candle[key] as number;
    }
    
    return null;
  }
}

