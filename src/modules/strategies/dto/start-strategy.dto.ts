import { IsString, IsNumber, IsOptional } from 'class-validator';

export class StartStrategyDto {
  @IsString()
  strategyId: string = 'rsi-edge';

  @IsString()
  exchange: string = 'binance';

  @IsString()
  symbol: string = 'BTC/USDT';

  @IsString()
  timeframe: string = '1m';

  @IsNumber()
  amountUSDT: number = 50;

  @IsNumber()
  @IsOptional()
  intervalMs: number = 60_000;
}
