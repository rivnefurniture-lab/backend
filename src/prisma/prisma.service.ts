import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private isConnected = false;
  private connectionAttempts = 0;
  private readonly maxRetries = 5;
  private readonly retryDelay = 3000; // 3 seconds

  constructor() {
    super({
      log: ['error', 'warn'],
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    while (this.connectionAttempts < this.maxRetries) {
      try {
        this.connectionAttempts++;
        this.logger.log(
          `🔄 Database connection attempt ${this.connectionAttempts}/${this.maxRetries}...`,
        );
        await this.$connect();
        this.isConnected = true;
        this.logger.log('✅ Database connected successfully');
        return;
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `⚠️ Connection attempt ${this.connectionAttempts} failed: ${errorMessage}`,
        );

        if (this.connectionAttempts < this.maxRetries) {
          this.logger.log(
            `⏳ Retrying in ${this.retryDelay / 1000} seconds...`,
          );
          await this.sleep(this.retryDelay);
        }
      }
    }

    this.logger.error(
      `❌ Failed to connect to database after ${this.maxRetries} attempts`,
    );
    this.logger.warn(
      '⚠️ App will continue without database - some features may not work',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.isConnected) {
      await this.$disconnect();
    }
  }

  /**
   * Execute a database operation with automatic retry
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    label = 'Database operation',
  ): Promise<T> {
    let lastError: Error = new Error('Unknown database error');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        const errorMessage = err.message || '';
        const errorCode = (error as { code?: string })?.code || '';

        const isConnectionError =
          errorMessage.includes("Can't reach database") ||
          errorCode === 'P1001' ||
          errorCode === 'P1002';

        if (isConnectionError && attempt < maxRetries) {
          this.logger.warn(
            `${label} failed (attempt ${attempt}/${maxRetries}), retrying...`,
          );
          await this.sleep(1000 * attempt); // Exponential backoff

          // Try to reconnect
          try {
            await this.$connect();
            this.isConnected = true;
          } catch {
            // Ignore reconnect errors
          }
        } else {
          throw err;
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if database is currently reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
