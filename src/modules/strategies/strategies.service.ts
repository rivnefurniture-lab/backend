import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { StartStrategyDto } from './dto/start-strategy.dto';
import { StopStrategyDto } from './dto/stop-strategy.dto';
import { rsiMeanReversion } from './rsi';

interface Job {
  id: string;
  strategyId: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  amountUSDT: number;
  timer: NodeJS.Timer;
}

@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);
  private jobs: Record<string, Job> = {};

  async start(dto: StartStrategyDto, exchangeInstance: any) {
    if (!exchangeInstance) {
      throw new BadRequestException('Exchange not connected');
    }

    const id = `job_${Date.now()}`;

    const tick = async () => {
      try {
        await rsiMeanReversion({
          exchange: exchangeInstance,
          symbol: dto.symbol,
          timeframe: dto.timeframe,
          amountUSDT: dto.amountUSDT,
          logger: (m: string) => this.logger.log(`[${id}] ${m}`),
        });
      } catch (e: any) {
        this.logger.error(`[${id}] ERROR: ${e.message}`);
      }
    };

    await tick();
    const timer = setInterval(tick, dto.intervalMs);

    this.jobs[id] = { ...dto, id, timer };
    this.logger.log(
      `Started job ${id}: ${dto.strategyId} on ${dto.exchange} ${dto.symbol}`,
    );

    return { ok: true, id };
  }

  stop(dto: StopStrategyDto) {
    const job = this.jobs[dto.jobId];
    if (job) {
      clearInterval(job.timer);
      delete this.jobs[dto.jobId];
      this.logger.log(`Stopped job ${dto.jobId}`);
    }
    return { ok: true };
  }

  list() {
    return { jobs: Object.values(this.jobs).map(({ timer, ...rest }) => rest) };
  }
}
