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

  async onModuleInit() {
    this.logger.log('Strategy Scheduler initialized - will calculate metrics on startup and every hour');
    // Wait for app to fully start, then calculate
    setTimeout(() => this.calculateAllPresetStrategies(), 30000);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlyCron() {
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
          this.logger.log(`Calculating: ${strategy.name}`);
          const result = await this.backtestService.calculatePresetStrategyMetrics(strategy.id);
          
          if (result.metrics) {
            await this.savePresetStrategyMetrics(strategy.id, strategy.name, result.metrics);
            this.logger.log(`✓ ${strategy.name}: ${result.metrics.yearly_return}% yearly, ${result.metrics.total_trades} trades, ${result.metrics.win_rate}% win rate`);
          } else {
            this.logger.warn(`✗ ${strategy.name}: ${result.error || 'No trades'}`);
          }
        } catch (error) {
          this.logger.error(`Failed ${strategy.name}: ${error.message}`);
        }
        
        // Wait between calculations to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      this.logger.log('Strategy metrics calculation completed');
    } catch (error) {
      this.logger.error(`Strategy calculation failed: ${error.message}`);
    } finally {
      this.isCalculating = false;
    }
  }

  private async savePresetStrategyMetrics(strategyId: string, strategyName: string, metrics: any) {
    // Find or create system user
    let systemUser = await this.prisma.user.findFirst({
      where: { email: 'system@algotcha.com' }
    });

    if (!systemUser) {
      systemUser = await this.prisma.user.create({
        data: { email: 'system@algotcha.com', name: 'System', supabaseId: 'system' }
      });
    }

    const existingStrategy = await this.prisma.strategy.findFirst({
      where: { name: strategyName, userId: systemUser.id, isPublic: true }
    });

    const templates = this.backtestService.getStrategyTemplates();
    const template = templates.find(t => t.id === strategyId);

    const strategyData = {
      name: strategyName,
      description: template?.description || `Preset: ${strategyName}`,
      category: template?.category || 'Preset',
      isPublic: true,
      isActive: false,
      lastBacktestProfit: metrics.net_profit,
      lastBacktestDrawdown: metrics.max_drawdown,
      lastBacktestSharpe: metrics.sharpe_ratio,
      lastBacktestWinRate: metrics.win_rate,
    };

    if (existingStrategy) {
      await this.prisma.strategy.update({ where: { id: existingStrategy.id }, data: strategyData });
    } else {
      await this.prisma.strategy.create({
        data: {
          ...strategyData,
          userId: systemUser.id,
          config: JSON.stringify({ entry_conditions: template?.entry_conditions || [], exit_conditions: template?.exit_conditions || [] }),
          pairs: JSON.stringify(template?.pairs || ['BTC/USDT']),
          maxDeals: 5,
          orderSize: 1000,
        }
      });
    }
  }
}
