import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BacktestService } from './backtest.service';
import { DataFetcherService } from './data-fetcher.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StrategySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(StrategySchedulerService.name);
  private isCalculating = false;

  constructor(
    private readonly backtestService: BacktestService,
    private readonly dataFetcher: DataFetcherService,
    private readonly prisma: PrismaService,
  ) {}

  // On startup - fetch data and calculate strategies
  async onModuleInit() {
    this.logger.log('Strategy Scheduler initialized');
    this.logger.log('Will calculate preset strategy metrics on startup and every hour');
    this.logger.log('Data will be updated every minute');
    
    // Wait for app to start
    setTimeout(async () => {
      // First, ensure we have data
      await this.dataFetcher.fetchAllHistoricalData();
      // Then calculate strategies
      await this.calculateAllPresetStrategies();
    }, 15000);
  }

  // Run every hour - recalculate all preset strategies
  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlyCron() {
    this.logger.log('Hourly strategy metrics update triggered');
    await this.calculateAllPresetStrategies();
  }

  // Calculate metrics for all preset strategies
  async calculateAllPresetStrategies() {
    if (this.isCalculating) {
      this.logger.log('Calculation already in progress, skipping...');
      return;
    }

    this.isCalculating = true;
    this.logger.log('Starting preset strategy metrics calculation...');

    try {
      const presetStrategies = this.backtestService.getStrategyTemplates();
      
      for (const strategy of presetStrategies) {
        try {
          this.logger.log(`Calculating metrics for: ${strategy.name}`);
          const result = await this.backtestService.calculatePresetStrategyMetrics(strategy.id);
          
          if (result.metrics) {
            // Save to database as a cached preset strategy
            await this.savePresetStrategyMetrics(strategy.id, strategy.name, result.metrics, result.yearlyPerformance);
            
            this.logger.log(`✓ ${strategy.name}: ${result.metrics.yearly_return}% yearly return, ${result.metrics.total_trades} trades`);
            
            // Log yearly breakdown
            if (result.yearlyPerformance.length > 0) {
              this.logger.log(`  Yearly breakdown:`);
              for (const yp of result.yearlyPerformance) {
                this.logger.log(`    ${yp.year}: ${yp.net_profit.toFixed(1)}% (${yp.total_trades} trades)`);
              }
            }
          }
        } catch (error) {
          this.logger.error(`Failed to calculate metrics for ${strategy.name}: ${error.message}`);
        }
        
        // Rate limiting - wait between calculations
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      this.logger.log('Preset strategy metrics calculation completed');
    } catch (error) {
      this.logger.error(`Strategy calculation failed: ${error.message}`);
    } finally {
      this.isCalculating = false;
    }
  }

  private async savePresetStrategyMetrics(
    strategyId: string,
    strategyName: string,
    metrics: any,
    yearlyPerformance: any[],
  ) {
    // Find or create a system user for preset strategies
    let systemUser = await this.prisma.user.findFirst({
      where: { email: 'system@algotcha.com' }
    });

    if (!systemUser) {
      systemUser = await this.prisma.user.create({
        data: {
          email: 'system@algotcha.com',
          name: 'System',
          supabaseId: 'system',
        }
      });
    }

    // Upsert the strategy
    const existingStrategy = await this.prisma.strategy.findFirst({
      where: { 
        name: strategyName,
        userId: systemUser.id,
        isPublic: true,
      }
    });

    const templates = this.backtestService.getStrategyTemplates();
    const template = templates.find(t => t.id === strategyId);

    // Build yearly performance description
    const yearlyDesc = yearlyPerformance.length > 0
      ? '\n\nYearly Performance:\n' + yearlyPerformance.map(yp => 
          `${yp.year}: ${yp.net_profit.toFixed(1)}% (${yp.total_trades} trades, ${yp.win_rate.toFixed(0)}% win rate)`
        ).join('\n')
      : '';

    const strategyData = {
      name: strategyName,
      description: (template?.description || `Preset strategy: ${strategyName}`) + yearlyDesc,
      category: template?.category || 'Preset',
      isPublic: true,
      isActive: false,
      lastBacktestProfit: metrics.net_profit,
      lastBacktestDrawdown: metrics.max_drawdown,
      lastBacktestSharpe: metrics.sharpe_ratio,
      lastBacktestWinRate: metrics.win_rate,
    };

    if (existingStrategy) {
      await this.prisma.strategy.update({
        where: { id: existingStrategy.id },
        data: strategyData,
      });
    } else {
      await this.prisma.strategy.create({
        data: {
          ...strategyData,
          userId: systemUser.id,
          config: JSON.stringify({
            entry_conditions: template?.entry_conditions || [],
            exit_conditions: template?.exit_conditions || [],
            take_profit: template?.take_profit,
            stop_loss: template?.stop_loss,
            yearlyPerformance,
          }),
          pairs: JSON.stringify(template?.pairs || ['BTC/USDT']),
          maxDeals: 5,
          orderSize: 1000,
        }
      });
    }
  }
}
