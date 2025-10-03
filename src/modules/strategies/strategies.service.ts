import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { StartStrategyDto } from './dto/start-strategy.dto';
import { StopStrategyDto } from './dto/stop-strategy.dto';
import { rsiMeanReversion } from './rsi';
import { Exchange } from 'ccxt';

interface Job {
  id: string;
  strategyId: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  amountUSDT: number;
  timer: NodeJS.Timer;
}

// TODO: FIX TS ERRORS
@Injectable()
export class StrategiesService {
  private readonly logger = new Logger(StrategiesService.name);
  private jobs: Record<string, Job> = {};

  async start(dto: StartStrategyDto, exchangeInstance: Exchange) {
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
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        this.logger.error(`[${id}] ERROR: ${e.message}`);
      }
    };

    await tick();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
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
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      clearInterval(job.timer);
      delete this.jobs[dto.jobId];
      this.logger.log(`Stopped job ${dto.jobId}`);
    }
    return { ok: true };
  }

  list() {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return { jobs: Object.values(this.jobs).map(({ timer, ...rest }) => rest) };
  }
}
