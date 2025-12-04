import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BacktestService } from './backtest.service';

@Injectable()
export class StrategySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(StrategySchedulerService.name);

  constructor(private readonly backtestService: BacktestService) {}

  async onModuleInit() {
    this.logger.log('Strategy Scheduler initialized');
    
    // Check data status on startup
    const status = this.backtestService.getDataStatus();
    this.logger.log(`Data status: ${status.fileCount} files, updating: ${status.isUpdating}`);
    
    if (status.hasData) {
      // Calculate strategies after 30 seconds
      setTimeout(() => {
        this.logger.log('Starting initial strategy calculation...');
        this.backtestService.calculateAllPresetStrategies();
      }, 30000);
    } else {
      this.logger.warn('No data files found. Run the fetcher script first.');
    }
  }
}
