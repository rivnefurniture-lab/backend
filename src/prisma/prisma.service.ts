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
  private readonly retryDelay = 2000; // 2 seconds (reduced from 3)

  constructor() {
    super({
      log: ['error'], // Only log errors, not warnings
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
        // Only log first attempt and success
        if (this.connectionAttempts === 1) {
          this.logger.log('🔄 Connecting to database...');
        }
        await this.$connect();
        this.isConnected = true;
        this.logger.log('✅ Database connected');
        return;
      } catch (error: unknown) {
        // Only log on final failure or first few attempts
        if (
          this.connectionAttempts >= this.maxRetries ||
          this.connectionAttempts <= 2
        ) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `DB connection attempt ${this.connectionAttempts}/${this.maxRetries} failed`,
          );
          if (this.connectionAttempts >= this.maxRetries) {
            this.logger.warn(`Last error: ${errorMessage.slice(0, 100)}`);
          }
        }

        if (this.connectionAttempts < this.maxRetries) {
          await this.sleep(this.retryDelay);
        }
      }
    }

    this.logger.error(
      `❌ Database connection failed after ${this.maxRetries} attempts`,
    );
    this.logger.warn('⚠️ App will continue - some features may not work');
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
