import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ExchangeModule, PrismaModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService],
})
export class StrategiesModule {}
