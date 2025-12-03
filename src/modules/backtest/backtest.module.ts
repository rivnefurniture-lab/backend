import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategySchedulerService } from './strategy-scheduler.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [BacktestController],
  providers: [BacktestService, StrategySchedulerService],
  exports: [BacktestService],
})
export class BacktestModule {}
