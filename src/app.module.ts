import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
import { SseModule } from './modules/sse/sse.module';
import { ExchangeModule } from './modules/exchange/exchange.module';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { BacktestModule } from './modules/backtest/backtest.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommentsModule,
    SseModule,
    ExchangeModule,
    AuthModule,
    BacktestModule, // Only add backtest for now
  ],
  controllers: [HealthController],
})
export class AppModule {}
