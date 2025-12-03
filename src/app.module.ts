import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
import { SseModule } from './modules/sse/sse.module';
import { ExchangeModule } from './modules/exchange/exchange.module';
import { StrategiesModule } from './modules/strategies/strategies.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommentsModule,
    SseModule,
    ExchangeModule,
    StrategiesModule,
    PaymentsModule,
    BacktestModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
