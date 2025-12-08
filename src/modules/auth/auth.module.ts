import { Module } from '@nestjs/common';
import { SupabaseProxyController } from './supabase-proxy.controller';

@Module({
  controllers: [SupabaseProxyController],
  providers: [],
  exports: [],
})
export class AuthModule {}
