import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RunBacktestDto } from './dto/backtest.dto';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// Time estimation constants (based on actual measurements)
const ESTIMATION = {
  BASE_TIME: 5, // seconds - setup overhead
  LOAD_TIME_PER_SYMBOL: 7, // seconds - file loading
  PROCESS_TIME_PER_MILLION_ROWS: 9, // seconds - condition checking
  ROWS_PER_YEAR: 525600, // 1m candles per year
  CONDITION_COMPLEXITY_FACTOR: 0.1, // additional time per condition
};

@Injectable()
export class QueueService {
  constructor(private prisma: PrismaService) {}

  /**
   * Estimate backtest completion time based on configuration
   * Returns estimated time in seconds
   */
  estimateBacktestTime(payload: RunBacktestDto): number {
    const config = payload as any;
    
    // Count symbols
    const symbols = config.pairs?.length || config.symbols?.length || 1;
    
    // Calculate date range in years
    const startDate = config.start_date ? new Date(config.start_date) : new Date('2023-01-01');
    const endDate = config.end_date ? new Date(config.end_date) : new Date();
    const years = (endDate.getTime() - startDate.getTime()) / (365 * 24 * 60 * 60 * 1000);
    
    // Count conditions
    const entryConditions = config.entry_conditions?.length || 1;
    const exitConditions = config.exit_conditions?.length || 1;
    const totalConditions = entryConditions + exitConditions;
    
    // Calculate estimated rows
    const rowsPerSymbol = years * ESTIMATION.ROWS_PER_YEAR;
    const totalRows = rowsPerSymbol * symbols;
    
    // Calculate time
    const loadTime = symbols * ESTIMATION.LOAD_TIME_PER_SYMBOL;
    const processTime = (totalRows / 1000000) * ESTIMATION.PROCESS_TIME_PER_MILLION_ROWS;
    const conditionMultiplier = 1 + (totalConditions - 2) * ESTIMATION.CONDITION_COMPLEXITY_FACTOR;
    
    const totalTime = ESTIMATION.BASE_TIME + loadTime + (processTime * conditionMultiplier);
    
    // Add 20% buffer for safety
    return Math.ceil(totalTime * 1.2);
  }

  /**
   * Get estimated completion time for a queue item
   */
  async getEstimatedCompletionTime(queueId: number): Promise<{
    estimatedSeconds: number;
    estimatedCompletion: Date;
    progress: number;
  } | null> {
    const item = await this.prisma.backtestQueue.findUnique({
      where: { id: queueId },
    });

    if (!item) return null;

    const payload = JSON.parse(item.payload) as RunBacktestDto;
    const estimatedSeconds = this.estimateBacktestTime(payload);
    
    let completionTime: Date;
    let progress = 0;

    if (item.status === 'processing' && item.startedAt) {
      const elapsed = (Date.now() - item.startedAt.getTime()) / 1000;
      progress = Math.min(95, (elapsed / estimatedSeconds) * 100);
      const remaining = Math.max(0, estimatedSeconds - elapsed);
      completionTime = new Date(Date.now() + remaining * 1000);
    } else if (item.status === 'queued') {
      // Add wait time for items ahead in queue
      const itemsAhead = await this.prisma.backtestQueue.count({
        where: {
          status: { in: ['queued', 'processing'] },
          createdAt: { lt: item.createdAt },
        },
      });
      const waitTime = itemsAhead * 60; // Assume 60s average per backtest ahead
      completionTime = new Date(Date.now() + (waitTime + estimatedSeconds) * 1000);
    } else {
      completionTime = item.completedAt || new Date();
      progress = 100;
    }

    return {
      estimatedSeconds,
      estimatedCompletion: completionTime,
      progress,
    };
  }

  async addToQueue(
    userId: number,
    strategyName: string,
    payload: RunBacktestDto,
    notifyVia: 'telegram' | 'email' | 'both' | 'whatsapp' | 'all',
    userEmail: string,
    userTelegramId?: string,
    userWhatsApp?: string | null,
  ) {
    // Get current queue length
    const queueLength = await this.prisma.backtestQueue.count({
      where: { status: { in: ['queued', 'processing'] } },
    });

    // Estimate this backtest's time
    const estimatedSeconds = this.estimateBacktestTime(payload);

    // Get total estimated wait (sum of all queued backtests)
    const queuedItems = await this.prisma.backtestQueue.findMany({
      where: { status: { in: ['queued', 'processing'] } },
      select: { payload: true, startedAt: true, status: true },
    });

    let totalWaitSeconds = 0;
    for (const item of queuedItems) {
      const itemPayload = JSON.parse(item.payload) as RunBacktestDto;
      const itemTime = this.estimateBacktestTime(itemPayload);
      if (item.status === 'processing' && item.startedAt) {
        // Subtract elapsed time for processing item
        const elapsed = (Date.now() - item.startedAt.getTime()) / 1000;
        totalWaitSeconds += Math.max(0, itemTime - elapsed);
      } else {
        totalWaitSeconds += itemTime;
      }
    }

    const queueItem = await this.prisma.backtestQueue.create({
      data: {
        userId,
        strategyName,
        payload: JSON.stringify(payload),
        notifyVia,
        notifyEmail: userEmail,
        notifyTelegram: userTelegramId || null,
        notifyWhatsApp: userWhatsApp || null,
        queuePosition: queueLength + 1,
        status: 'queued',
      },
    });

    const estimatedCompletion = new Date(Date.now() + (totalWaitSeconds + estimatedSeconds) * 1000);

    return {
      queueId: queueItem.id,
      position: queueLength + 1,
      estimatedSeconds,
      estimatedWaitSeconds: totalWaitSeconds,
      estimatedCompletion: estimatedCompletion.toISOString(),
    };
  }

  async getQueuePosition(queueId: number) {
    const item = await this.prisma.backtestQueue.findUnique({
      where: { id: queueId },
    });

    if (!item) {
      return null;
    }

    // Count items ahead in queue
    const position = await this.prisma.backtestQueue.count({
      where: {
        status: { in: ['queued', 'processing'] },
        createdAt: { lt: item.createdAt },
      },
    });

    return {
      ...item,
      queuePosition: position + 1,
    };
  }

  async getNextInQueue() {
    return await this.prisma.backtestQueue.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      include: { user: true },
    });
  }

  async updateStatus(
    queueId: number,
    status: 'processing' | 'completed' | 'failed',
    progress?: number,
    resultId?: number,
    error?: string,
  ) {
    const data: any = { status, progress };

    if (status === 'processing') {
      data.startedAt = new Date();
    }

    if (status === 'completed' || status === 'failed') {
      data.completedAt = new Date();
    }

    if (resultId) {
      data.resultId = resultId;
    }

    if (error) {
      data.errorMessage = error;
    }

    return await this.prisma.backtestQueue.update({
      where: { id: queueId },
      data,
    });
  }

  async getUserQueueItems(userId: number) {
    return await this.prisma.backtestQueue.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}
