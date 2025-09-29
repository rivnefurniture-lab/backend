import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { ExchangeModule } from '../exchange/exchange.module';

@Module({
  imports: [ExchangeModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
})
export class StrategiesModule {}
