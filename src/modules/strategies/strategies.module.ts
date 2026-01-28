import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { DataServerModule } from '../data-server/data-server.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [ExchangeModule, PrismaModule, DataServerModule, SubscriptionModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService],
})
export class StrategiesModule {}
