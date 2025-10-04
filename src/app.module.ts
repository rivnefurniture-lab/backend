import { Module } from '@nestjs/common';
// import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
import { SseModule } from './modules/sse/sse.module';
import { ExchangeModule } from './modules/exchange/exchange.module';

// Auth module is disabled because authentication is handled by Supabase.
@Module({
  imports: [CommentsModule, SseModule, ExchangeModule],
})
export class AppModule {}
