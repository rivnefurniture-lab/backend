import { IsString, IsNumber } from 'class-validator';

export class MarketOrderDto {
  @IsString()
  exchange!: string;

  @IsString()
  symbol!: string;

  @IsString()
  side!: 'buy' | 'sell';

  @IsNumber()
  amountBase!: number;
}
