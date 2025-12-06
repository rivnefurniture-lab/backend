import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface DataRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  RSI_14?: number;
  RSI_28?: number;
  SMA_20?: number;
  SMA_50?: number;
  SMA_200?: number;
  'BB_%B_20_2'?: number;
  'BB_%B_20_1'?: number;
  MACD?: number;
  [key: string]: any;
}

interface SignalCheckResult {
  symbol: string;
  signalTriggered: boolean;
  timestamp: string;
  price: number;
  conditions: Array<{
    indicator: string;
    value: number | null;
    threshold: number;
    operator: string;
    met: boolean;
  }>;
}

@Injectable()
export class HetznerService {
  private readonly logger = new Logger(HetznerService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000; // 30 seconds

  constructor() {
    this.baseUrl = process.env.HETZNER_DATA_URL || 'http://46.224.99.27:5000';
    this.apiKey = process.env.HETZNER_API_KEY || '';
    this.logger.log(`Hetzner Data Service initialized: ${this.baseUrl}`);
  }

  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<T | null> {
    try {
      const response = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        data: body,
        timeout: 10000,
      });
      return response.data;
    } catch (error: any) {
      this.logger.error(`Hetzner request failed: ${path} - ${error.message}`);
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
      return response.data?.status === 'healthy';
    } catch {
      return false;
    }
  }

  async getDataStatus(): Promise<{ hasData: boolean; fileCount: number; files: any[] }> {
    const result = await this.request<{ hasData: boolean; fileCount: number; files: any[] }>('/data/status');
    return result || { hasData: false, fileCount: 0, files: [] };
  }

  async getLatestData(symbol: string): Promise<DataRow | null> {
    // Check cache first
    const cacheKey = `latest_${symbol}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const result = await this.request<{ symbol: string; timestamp: string; data: DataRow }>(`/data/latest/${encodeURIComponent(symbol)}`);
    
    if (result?.data) {
      this.cache.set(cacheKey, { data: result.data, timestamp: Date.now() });
      return result.data;
    }
    return null;
  }

  async getDataRange(symbol: string, limit: number = 100): Promise<DataRow[]> {
    const result = await this.request<{ symbol: string; count: number; data: DataRow[] }>(`/data/range/${encodeURIComponent(symbol)}?limit=${limit}`);
    return result?.data || [];
  }

  async checkSignal(symbol: string, conditions: Array<{ indicator: string; operator: string; value: number }>): Promise<SignalCheckResult | null> {
    const result = await this.request<SignalCheckResult>('/signal/check', 'POST', { symbol, conditions });
    return result;
  }

  // Get indicator value from latest data
  async getIndicatorValue(symbol: string, indicator: string): Promise<number | null> {
    const data = await this.getLatestData(symbol);
    if (!data) return null;
    
    const value = data[indicator];
    return typeof value === 'number' ? value : null;
  }

  // Check multiple conditions for a symbol
  async checkConditions(
    symbol: string,
    conditions: Array<{ indicator: string; operator: string; value: number }>
  ): Promise<{ allMet: boolean; results: Array<{ indicator: string; met: boolean; currentValue: number | null }> }> {
    const data = await this.getLatestData(symbol);
    if (!data) {
      return { allMet: false, results: [] };
    }

    const results: Array<{ indicator: string; met: boolean; currentValue: number | null }> = [];
    let allMet = true;

    for (const cond of conditions) {
      const currentValue = data[cond.indicator];
      let met = false;

      if (currentValue !== undefined && currentValue !== null) {
        switch (cond.operator) {
          case 'GreaterThan':
            met = currentValue > cond.value;
            break;
          case 'LessThan':
            met = currentValue < cond.value;
            break;
          case 'Equals':
            met = currentValue === cond.value;
            break;
        }
      }

      results.push({ indicator: cond.indicator, met, currentValue: currentValue ?? null });
      if (!met) allMet = false;
    }

    return { allMet, results };
  }

  // Get current price for a symbol
  async getCurrentPrice(symbol: string): Promise<number | null> {
    const data = await this.getLatestData(symbol);
    return data?.close ?? null;
  }

  // Clear cache (useful after data update)
  clearCache() {
    this.cache.clear();
  }
}

