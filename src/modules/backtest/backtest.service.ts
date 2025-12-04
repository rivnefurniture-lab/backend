// src/modules/backtest/backtest.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RunBacktestDto, StrategyCondition } from './dto/backtest.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface BacktestMetrics {
  net_profit: number;
  net_profit_usd: string;
  total_profit: number;
  total_profit_usd: string;
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

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private readonly scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts');
  private readonly staticDir = path.join(__dirname, '..', '..', '..', 'static');
  private isUpdatingData = false;

  // Predefined strategy templates
  private readonly strategyTemplates: Record<string, {
    name: string;
    description: string;
    category: string;
    pairs: string[];
    entry_conditions: StrategyCondition[];
    exit_conditions: StrategyCondition[];
    take_profit?: number;
    stop_loss?: number;
    target_profit?: number;
    stop_loss_value?: number;
    price_change_active?: boolean;
    stop_loss_toggle?: boolean;
    conditions_active?: boolean;
  }> = {
    'rsi-ma-bb-golden': {
      name: 'RSI+MA+BB Golden Strategy',
      description: 'RSI > 70 entry on 1h + SMA 50/200 crossover, exits on BB%B < 0.2',
      category: 'Multi-Indicator / Trend & Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 28, Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 70 } },
        { indicator: 'MA', subfields: { 'MA Type': 'SMA', 'Fast MA': 50, 'Slow MA': 200, Condition: 'Greater Than', Timeframe: '1h' } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Less Than', Timeframe: '1h', 'Signal Value': 0.2 } }
      ],
      conditions_active: true
    },
    'rsi-oversold-scalper': {
      name: 'RSI Oversold Scalper',
      description: 'Buys when RSI < 30, sells when RSI > 70 with TP/SL',
      category: 'Scalping / Mean Reversion',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '1h', Condition: 'Less Than', 'Signal Value': 30 } }
      ],
      exit_conditions: [
        { indicator: 'RSI', subfields: { 'RSI Length': 14, Timeframe: '1h', Condition: 'Greater Than', 'Signal Value': 70 } }
      ],
      target_profit: 5,
      stop_loss_value: 3,
      price_change_active: true,
      stop_loss_toggle: true,
      conditions_active: true
    },
    'macd-trend-follower': {
      name: 'MACD Trend Follower',
      description: 'Follows MACD crossovers on 4h timeframe',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT'],
      entry_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '4h', 'MACD Trigger': 'Crossing Up', 'Line Trigger': 'Greater Than 0' } }
      ],
      exit_conditions: [
        { indicator: 'MACD', subfields: { 'MACD Preset': '12,26,9', Timeframe: '4h', 'MACD Trigger': 'Crossing Down' } }
      ],
      conditions_active: true
    },
    'bb-squeeze-breakout': {
      name: 'Bollinger Squeeze Breakout',
      description: 'Enters when price breaks above upper BB',
      category: 'Volatility Breakout',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Greater Than', Timeframe: '1h', 'Signal Value': 1.0 } }
      ],
      exit_conditions: [
        { indicator: 'BollingerBands', subfields: { 'BB% Period': 20, Deviation: 2, Condition: 'Less Than', Timeframe: '1h', 'Signal Value': 0.5 } }
      ],
      target_profit: 5,
      stop_loss_value: 2,
      price_change_active: true,
      stop_loss_toggle: true,
      conditions_active: true
    },
    'dual-ma-crossover': {
      name: 'Dual MA Crossover',
      description: 'Classic EMA 20/50 crossover strategy on 4h',
      category: 'Trend Following',
      pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      entry_conditions: [
        { indicator: 'MA', subfields: { 'MA Type': 'EMA', 'Fast MA': 20, 'Slow MA': 50, Condition: 'Crossing Up', Timeframe: '4h' } }
      ],
      exit_conditions: [
        { indicator: 'MA', subfields: { 'MA Type': 'EMA', 'Fast MA': 20, 'Slow MA': 50, Condition: 'Crossing Down', Timeframe: '4h' } }
      ],
      conditions_active: true
    }
  };

  // Cache for preset strategy metrics
  private presetMetricsCache: Map<string, { 
    metrics: BacktestMetrics; 
    calculatedAt: Date 
  }> = new Map();

  constructor(private readonly prisma: PrismaService) {
    // Check if static dir exists
    if (!fs.existsSync(this.staticDir)) {
      fs.mkdirSync(this.staticDir, { recursive: true });
    }
  }

  // Run hourly data update
  @Cron(CronExpression.EVERY_HOUR)
  async updateDataHourly() {
    if (this.isUpdatingData) {
      this.logger.log('Data update already in progress, skipping...');
      return;
    }

    this.isUpdatingData = true;
    this.logger.log('Starting hourly data update...');

    try {
      await this.runPythonScript('update_data.py');
      this.logger.log('Hourly data update completed');
      
      // Recalculate preset strategies after data update
      await this.calculateAllPresetStrategies();
    } catch (error) {
      this.logger.error(`Data update failed: ${error.message}`);
    } finally {
      this.isUpdatingData = false;
    }
  }

  // Calculate all preset strategies
  async calculateAllPresetStrategies() {
    this.logger.log('Calculating preset strategy metrics...');
    
    for (const [id, template] of Object.entries(this.strategyTemplates)) {
      try {
        const result = await this.calculatePresetStrategyMetrics(id);
        if (result.metrics) {
          this.logger.log(`✓ ${template.name}: ${result.metrics.yearly_return}% yearly`);
        }
      } catch (error) {
        this.logger.error(`Failed ${template.name}: ${error.message}`);
      }
    }
  }

  // Run Python script helper
  private runPythonScript(scriptName: string, args: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptsDir, scriptName);
      const python = spawn('python3', [scriptPath, ...args]);
      
      let stdout = '';
      let stderr = '';
      
      python.stdout.on('data', (data) => {
        stdout += data.toString();
        this.logger.debug(data.toString().trim());
      });
      
      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      python.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Python script failed with code ${code}: ${stderr}`));
        }
      });
      
      python.on('error', (error) => {
        reject(error);
      });
    });
  }

  // Run backtest using Python
  private async runPythonBacktest(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptsDir, 'backtest.py');
      const python = spawn('python3', ['-c', `
import sys
import json
sys.path.insert(0, '${this.scriptsDir}')
from backtest import run_backtest

payload = json.loads('''${JSON.stringify(payload)}''')
result = run_backtest(payload)

# Convert non-serializable types
if 'df_out' in result:
    del result['df_out']

print(json.dumps(result))
`]);
      
      let stdout = '';
      let stderr = '';
      
      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log but don't treat as error (Python logging goes to stderr)
        if (!data.toString().includes('UserWarning')) {
          this.logger.debug(`Python: ${data.toString().trim()}`);
        }
      });
      
      python.on('close', (code) => {
        try {
          // Find the last JSON object in stdout
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const result = JSON.parse(lines[i]);
              resolve(result);
              return;
            } catch {
              continue;
            }
          }
          reject(new Error(`No valid JSON in output: ${stdout.substring(0, 500)}`));
        } catch (error) {
          reject(new Error(`Failed to parse result: ${error.message}`));
        }
      });
      
      python.on('error', (error) => {
        reject(error);
      });
    });
  }

  getStrategyTemplates() {
    return Object.entries(this.strategyTemplates).map(([id, template]) => ({
      id,
      ...template
    }));
  }

  async getPresetStrategiesWithMetrics() {
    const strategies: any[] = [];
    
    for (const [id, template] of Object.entries(this.strategyTemplates)) {
      const cached = this.presetMetricsCache.get(id);
      const isFresh = !!(cached && (Date.now() - cached.calculatedAt.getTime()) < 60 * 60 * 1000);
      
      const metrics = isFresh ? cached.metrics : null;
      const cagr = metrics?.yearly_return || 0;
      
      strategies.push({
        id,
        name: template.name,
        description: template.description,
        category: template.category,
        pairs: template.pairs,
        config: {
          entry_conditions: template.entry_conditions,
          exit_conditions: template.exit_conditions,
        },
        cagr,
        sharpe: metrics?.sharpe_ratio || 0,
        maxDD: metrics?.max_drawdown || 0,
        winRate: metrics?.win_rate || 0,
        totalTrades: metrics?.total_trades || 0,
        returns: {
          daily: (cagr / 365).toFixed(3),
          weekly: (cagr / 52).toFixed(2),
          monthly: (cagr / 12).toFixed(1),
          yearly: cagr,
        },
        isRealData: isFresh,
        isPreset: true,
        updatedAt: isFresh ? cached.calculatedAt.toISOString() : null,
        needsCalculation: !isFresh,
      });
    }
    
    return strategies;
  }

  async calculatePresetStrategyMetrics(strategyId: string): Promise<{
    id: string;
    name: string;
    metrics: BacktestMetrics | null;
    error?: string;
  }> {
    const template = this.strategyTemplates[strategyId];
    
    if (!template) {
      return { id: strategyId, name: 'Unknown', metrics: null, error: 'Strategy not found' };
    }

    // Check if data files exist
    const dataFile = path.join(this.staticDir, 'BTC_USDT_all_tf_merged.parquet');
    if (!fs.existsSync(dataFile)) {
      return { 
        id: strategyId, 
        name: template.name, 
        metrics: null, 
        error: 'Data files not found. Run the fetcher first.' 
      };
    }
    
    try {
      this.logger.log(`Calculating: ${template.name}`);
      
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 1);
      
      const payload = {
        strategy_name: template.name.replace(/[^a-zA-Z0-9]/g, '_'),
        pairs: template.pairs.slice(0, 3),
        initial_balance: 10000,
        base_order_size: 1000,
        max_active_deals: 3,
        trading_fee: 0.1,
        entry_conditions: template.entry_conditions,
        exit_conditions: template.exit_conditions,
        conditions_active: template.conditions_active || true,
        price_change_active: template.price_change_active || false,
        target_profit: template.target_profit || 0,
        stop_loss_toggle: template.stop_loss_toggle || false,
        stop_loss_value: template.stop_loss_value || 0,
        start_date: startDate.toISOString().split('T')[0],
        end_date: new Date().toISOString().split('T')[0],
      };
      
      const result = await this.runPythonBacktest(payload);
      
      if (result.status === 'success' && result.metrics) {
        const metrics: BacktestMetrics = {
          net_profit: (result.metrics.net_profit || 0) * 100,
          net_profit_usd: result.metrics.net_profit_usd || '$0',
          total_profit: (result.metrics.total_profit || 0) * 100,
          total_profit_usd: result.metrics.total_profit_usd || '$0',
          max_drawdown: (result.metrics.max_drawdown || 0) * 100,
          max_realized_drawdown: (result.metrics.max_realized_drawdown || 0) * 100,
          sharpe_ratio: result.metrics.sharpe_ratio || 0,
          sortino_ratio: result.metrics.sortino_ratio || 0,
          win_rate: (result.metrics.win_rate || 0) * 100,
          total_trades: result.metrics.total_trades || 0,
          profit_factor: result.metrics.profit_factor || 0,
          avg_profit_per_trade: result.metrics.avg_profit_per_trade || 0,
          yearly_return: (result.metrics.yearly_return || 0) * 100,
          exposure_time_frac: (result.metrics.exposure_time_frac || 0) * 100,
        };
        
        this.presetMetricsCache.set(strategyId, {
          metrics,
          calculatedAt: new Date(),
        });
        
        return { id: strategyId, name: template.name, metrics };
      }
      
      return {
        id: strategyId,
        name: template.name,
        metrics: null,
        error: result.message || 'No trades generated',
      };
    } catch (error) {
      this.logger.error(`Failed ${strategyId}: ${error.message}`);
      return { id: strategyId, name: template.name, metrics: null, error: error.message };
    }
  }

  getAvailableIndicators() {
    return [
      {
        id: 'RSI',
        name: 'Relative Strength Index',
        params: [
          { key: 'RSI Length', type: 'number', default: 14, min: 2, max: 100 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Less Than' },
          { key: 'Signal Value', type: 'number', default: 30, min: 0, max: 100 }
        ]
      },
      {
        id: 'MA',
        name: 'Moving Average',
        params: [
          { key: 'MA Type', type: 'select', options: ['SMA', 'EMA'], default: 'SMA' },
          { key: 'Fast MA', type: 'number', default: 20, min: 1, max: 500 },
          { key: 'Slow MA', type: 'number', default: 50, min: 1, max: 500 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '4h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Crossing Up' }
        ]
      },
      {
        id: 'MACD',
        name: 'MACD',
        params: [
          { key: 'MACD Preset', type: 'select', options: ['12,26,9', '6,20,9', '9,30,9', '15,35,9', '18,40,9'], default: '12,26,9' },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '4h' },
          { key: 'MACD Trigger', type: 'select', options: ['Crossing Up', 'Crossing Down'], default: 'Crossing Up' },
          { key: 'Line Trigger', type: 'select', options: ['', 'Less Than 0', 'Greater Than 0'], default: '' }
        ]
      },
      {
        id: 'BollingerBands',
        name: 'Bollinger Bands %B',
        params: [
          { key: 'BB% Period', type: 'number', default: 20, min: 5, max: 100 },
          { key: 'Deviation', type: 'select', options: [1, 1.5, 2, 2.5, 3], default: 2 },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Less Than' },
          { key: 'Signal Value', type: 'number', default: 0, min: -1, max: 2 }
        ]
      },
      {
        id: 'Stochastic',
        name: 'Stochastic Oscillator',
        params: [
          { key: 'Stochastic Preset', type: 'select', options: ['14,3,3', '14,3,5', '20,5,5', '21,7,7', '28,9,9'], default: '14,3,3' },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'K Condition', type: 'select', options: ['Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'], default: 'Less Than' },
          { key: 'K Signal Value', type: 'number', default: 20, min: 0, max: 100 },
          { key: 'Condition', type: 'select', options: ['', 'K Crossing Up D', 'K Crossing Down D'], default: '' }
        ]
      },
      {
        id: 'ParabolicSAR',
        name: 'Parabolic SAR',
        params: [
          { key: 'PSAR Preset', type: 'select', options: ['0.02,0.2', '0.03,0.2', '0.04,0.3', '0.05,0.4', '0.06,0.5'], default: '0.02,0.2' },
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Condition', type: 'select', options: ['Crossing (Long)', 'Crossing (Short)'], default: 'Crossing (Long)' }
        ]
      },
      {
        id: 'TradingView',
        name: 'TradingView Technical Rating',
        params: [
          { key: 'Timeframe', type: 'select', options: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' },
          { key: 'Signal Value', type: 'select', options: ['Strong Buy', 'Buy', 'Neutral', 'Sell', 'Strong Sell'], default: 'Buy' }
        ]
      }
    ];
  }

  // Main backtest function - uses Python
  async runBacktest(dto: RunBacktestDto): Promise<any> {
    this.logger.log(`Running backtest: ${dto.strategy_name}`);
    
    // Check if data files exist
    const dataFile = path.join(this.staticDir, 'BTC_USDT_all_tf_merged.parquet');
    if (!fs.existsSync(dataFile)) {
      return { 
        status: 'error', 
        message: 'Data files not found. Please wait for the data fetcher to complete.',
      };
    }
    
    const payload = {
      strategy_name: (dto.strategy_name || 'backtest').replace(/[^a-zA-Z0-9]/g, '_'),
      pairs: dto.pairs || ['BTC/USDT'],
      initial_balance: dto.initial_balance || 10000,
      base_order_size: dto.base_order_size || 1000,
      max_active_deals: dto.max_active_deals || 5,
      trading_fee: dto.trading_fee || 0.1,
      entry_conditions: dto.entry_conditions || dto.bullish_entry_conditions || [],
      exit_conditions: dto.exit_conditions || dto.bullish_exit_conditions || [],
      safety_order_toggle: dto.safety_order_toggle || false,
      safety_order_size: dto.safety_order_size || 0,
      price_deviation: dto.price_deviation || 0,
      max_safety_orders_count: dto.max_safety_orders_count || 0,
      safety_order_volume_scale: dto.safety_order_volume_scale || 1,
      safety_order_step_scale: dto.safety_order_step_scale || 1,
      safety_conditions: dto.safety_conditions || [],
      price_change_active: dto.price_change_active || false,
      conditions_active: dto.conditions_active !== false,
      target_profit: dto.target_profit || dto.take_profit || 0,
      trailing_toggle: dto.trailing_toggle || false,
      trailing_deviation: dto.trailing_deviation || 0,
      minprof_toggle: dto.minprof_toggle || false,
      minimal_profit: dto.minimal_profit || 0,
      stop_loss_toggle: dto.stop_loss_toggle || !!dto.stop_loss,
      stop_loss_value: dto.stop_loss_value || dto.stop_loss || 0,
      stop_loss_timeout: dto.stop_loss_timeout || 0,
      reinvest_profit: dto.reinvest_profit || 0,
      risk_reduction: dto.risk_reduction || 0,
      cooldown_between_deals: dto.cooldown_between_deals || 0,
      close_deal_after_timeout: dto.close_deal_after_timeout || 0,
      start_date: dto.start_date || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date: dto.end_date || new Date().toISOString().split('T')[0],
    };
    
    try {
      const result = await this.runPythonBacktest(payload);
      
      // Format metrics for frontend
      if (result.status === 'success' && result.metrics) {
        result.metrics = {
          ...result.metrics,
          net_profit: (result.metrics.net_profit || 0) * 100,
          total_profit: (result.metrics.total_profit || 0) * 100,
          max_drawdown: (result.metrics.max_drawdown || 0) * 100,
          max_realized_drawdown: (result.metrics.max_realized_drawdown || 0) * 100,
          win_rate: (result.metrics.win_rate || 0) * 100,
          yearly_return: (result.metrics.yearly_return || 0) * 100,
          exposure_time_frac: (result.metrics.exposure_time_frac || 0) * 100,
        };
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Backtest failed: ${error.message}`);
      return { status: 'error', message: error.message };
    }
  }

  // Database methods
  async saveBacktestResult(userId: number, dto: RunBacktestDto, result: any) {
    return this.prisma.backtestResult.create({
      data: {
        userId,
        name: dto.strategy_name,
        config: JSON.stringify({ entry_conditions: dto.entry_conditions, exit_conditions: dto.exit_conditions }),
        pairs: JSON.stringify(dto.pairs || []),
        startDate: new Date(dto.start_date || Date.now() - 90 * 24 * 60 * 60 * 1000),
        endDate: new Date(dto.end_date || Date.now()),
        initialBalance: dto.initial_balance || 10000,
        netProfit: result.metrics?.net_profit || 0,
        netProfitUsd: parseFloat(result.metrics?.net_profit_usd?.replace('$', '') || '0'),
        maxDrawdown: result.metrics?.max_drawdown || 0,
        sharpeRatio: result.metrics?.sharpe_ratio || 0,
        sortinoRatio: result.metrics?.sortino_ratio || 0,
        winRate: result.metrics?.win_rate || 0,
        totalTrades: result.metrics?.total_trades || 0,
        profitFactor: typeof result.metrics?.profit_factor === 'number' ? result.metrics.profit_factor : 0,
        yearlyReturn: result.metrics?.yearly_return || 0,
        chartData: JSON.stringify(result.chartData || {}),
        trades: JSON.stringify([]),
      }
    });
  }

  async getBacktestResults(userId?: number) {
    const results = await this.prisma.backtestResult.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return results.map(r => ({
      id: r.id,
      strategy_name: r.name,
      timestamp_run: r.createdAt.toISOString(),
      net_profit: r.netProfit,
      max_drawdown: r.maxDrawdown,
      sharpe_ratio: r.sharpeRatio,
      total_trades: r.totalTrades,
      win_rate: r.winRate,
      yearly_return: r.yearlyReturn,
    }));
  }

  async getBacktestResult(id: number, userId?: number) {
    const result = await this.prisma.backtestResult.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
    });
    if (!result) return null;
    return {
      ...result,
      config: JSON.parse(result.config),
      pairs: JSON.parse(result.pairs),
      chartData: result.chartData ? JSON.parse(result.chartData) : null,
      trades: result.trades ? JSON.parse(result.trades) : [],
    };
  }

  async saveAsStrategy(userId: number, backtestId: number, name: string, description?: string) {
    const backtest = await this.prisma.backtestResult.findFirst({ where: { id: backtestId, userId } });
    if (!backtest) throw new Error('Backtest result not found');
    
    return this.prisma.strategy.create({
      data: {
        userId, name, description, category: 'Custom',
        config: backtest.config, pairs: backtest.pairs,
        maxDeals: 5, orderSize: 1000,
        lastBacktestProfit: backtest.netProfit,
        lastBacktestDrawdown: backtest.maxDrawdown,
        lastBacktestSharpe: backtest.sharpeRatio,
        lastBacktestWinRate: backtest.winRate,
      }
    });
  }

  async deleteBacktestResult(id: number, userId: number) {
    await this.prisma.backtestResult.deleteMany({ where: { id, userId } });
    return { success: true };
  }

  // Manual data update trigger
  async triggerDataUpdate() {
    if (this.isUpdatingData) {
      return { status: 'busy', message: 'Data update already in progress' };
    }
    
    // Run in background
    this.updateDataHourly().catch(e => this.logger.error(`Update failed: ${e.message}`));
    
    return { status: 'started', message: 'Data update started in background' };
  }

  // Check data status
  getDataStatus() {
    const files = fs.readdirSync(this.staticDir).filter(f => f.endsWith('.parquet'));
    
    return {
      hasData: files.length > 0,
      fileCount: files.length,
      files: files.slice(0, 10),
      isUpdating: this.isUpdatingData,
    };
  }
}
