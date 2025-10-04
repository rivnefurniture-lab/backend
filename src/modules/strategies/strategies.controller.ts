import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { StartStrategyDto } from './dto/start-strategy.dto';
import { StopStrategyDto } from './dto/stop-strategy.dto';
import { ExchangeService } from '../exchange/exchange.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('strategies')
export class StrategiesController {
  constructor(
    private readonly strategies: StrategiesService,
    private readonly exchange: ExchangeService,
  ) {}

  @Get('jobs')
  getJobs() {
    return this.strategies.list();
  }

  @Post('start')
  async start(@Body() dto: StartStrategyDto) {
    const conn = this.exchange.getConnection(dto.exchange);
    return this.strategies.start(dto, conn?.instance);
  }

  @Post('stop')
  stop(@Body() dto: StopStrategyDto) {
    return this.strategies.stop(dto);
  }
}
