import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { DataFetcherService } from './data-fetcher.service';
import { StrategySchedulerService } from './strategy-scheduler.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [BacktestController],
  providers: [BacktestService, DataFetcherService, StrategySchedulerService],
  exports: [BacktestService, DataFetcherService],
})
export class BacktestModule {}
