import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BacktestService } from './backtest.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StrategySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(StrategySchedulerService.name);
  private isCalculating = false;

  constructor(
    private readonly backtestService: BacktestService,
    private readonly prisma: PrismaService,
  ) {}

  // Calculate on startup
  async onModuleInit() {
    this.logger.log('Strategy Scheduler initialized - will calculate metrics on startup and every hour');
    // Wait a bit for the app to fully start
    setTimeout(() => this.calculateAllPresetStrategies(), 10000);
  }

  // Run every hour
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    this.logger.log('Hourly strategy metrics update triggered');
    await this.calculateAllPresetStrategies();
  }

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
            await this.savePresetStrategyMetrics(strategy.id, strategy.name, result.metrics);
            this.logger.log(`✓ Updated metrics for ${strategy.name}: ${result.metrics.yearly_return}% yearly return`);
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

    const strategyData = {
      name: strategyName,
      description: `Preset strategy: ${strategyName}`,
      category: 'Preset',
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
      const templates = this.backtestService.getStrategyTemplates();
      const template = templates.find(t => t.id === strategyId);
      
      await this.prisma.strategy.create({
        data: {
          ...strategyData,
          userId: systemUser.id,
          config: JSON.stringify(template || {}),
          pairs: JSON.stringify(template?.pairs || ['BTC/USDT']),
          maxDeals: 5,
          orderSize: 1000,
        }
      });
    }
  }
}

