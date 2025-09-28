import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
// import { ExchangeModule } from './modules/exchange/exchange.module';

@Module({
  imports: [AuthModule, CommentsModule], // ExchangeModule
})
export class AppModule {}
