import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { HetznerModule } from '../hetzner/hetzner.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [ExchangeModule, PrismaModule, HetznerModule, SubscriptionModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService],
})
export class StrategiesModule {}
