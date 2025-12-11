import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategySchedulerService } from './strategy-scheduler.service';
import { QueueService } from './queue.service';
import { NotificationService } from './notification.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [BacktestController],
  providers: [BacktestService, StrategySchedulerService, QueueService, NotificationService],
  exports: [BacktestService, QueueService],
})
export class BacktestModule {}
