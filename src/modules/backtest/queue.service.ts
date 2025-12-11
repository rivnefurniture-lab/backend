import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RunBacktestDto } from './dto/backtest.dto';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

@Injectable()
export class QueueService {
  constructor(private prisma: PrismaService) {}

  async addToQueue(
    userId: number,
    strategyName: string,
    payload: RunBacktestDto,
    notifyVia: 'telegram' | 'email' | 'both',
    userEmail: string,
    userTelegramId?: string,
  ) {
    // Get current queue length
    const queueLength = await this.prisma.backtestQueue.count({
      where: { status: { in: ['queued', 'processing'] } },
    });

    const queueItem = await this.prisma.backtestQueue.create({
      data: {
        userId,
        strategyName,
        payload: JSON.stringify(payload),
        notifyVia,
        notifyEmail: userEmail,
        notifyTelegram: userTelegramId || null,
        queuePosition: queueLength + 1,
        status: 'queued',
      },
    });

    return {
      queueId: queueItem.id,
      position: queueLength + 1,
      estimatedWait: queueLength * 15, // Estimate 15 min per backtest
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

