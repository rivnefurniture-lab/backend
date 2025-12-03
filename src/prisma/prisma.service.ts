import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('✅ Database connected');
    } catch (error) {
      this.logger.error('❌ Database connection failed:', error);
      // Don't throw - let the app start anyway for non-db features
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
