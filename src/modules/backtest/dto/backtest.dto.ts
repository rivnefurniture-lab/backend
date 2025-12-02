import { IsString, IsNumber, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ConditionSubfields {
  @IsOptional()
  @IsString()
  Timeframe?: string = '1m';

  @IsOptional()
  @IsString()
  Condition?: string; // 'Less Than', 'Greater Than', 'Crossing Up', 'Crossing Down'

  @IsOptional()
  @IsNumber()
  'Signal Value'?: number;

  @IsOptional()
  @IsNumber()
  'RSI Length'?: number = 14;

  @IsOptional()
  @IsString()
  'MA Type'?: string = 'SMA';

  @IsOptional()
  @IsNumber()
  'Fast MA'?: number = 14;

  @IsOptional()
  @IsNumber()
  'Slow MA'?: number = 28;

  @IsOptional()
  @IsNumber()
  'BB% Period'?: number = 20;

  @IsOptional()
  @IsNumber()
  Deviation?: number = 2;

  @IsOptional()
  @IsString()
  'MACD Preset'?: string = '12,26,9';

  @IsOptional()
  @IsString()
  'MACD Trigger'?: string; // 'Crossing Up', 'Crossing Down'

  @IsOptional()
  @IsString()
  'Line Trigger'?: string; // 'Less Than 0', 'Greater Than 0'
}

export class StrategyCondition {
  @IsString()
  indicator: string; // 'RSI', 'MA', 'BollingerBands', 'MACD'

  @ValidateNested()
  @Type(() => ConditionSubfields)
  subfields: ConditionSubfields;
}

export class RunBacktestDto {
  @IsString()
  strategy_name: string;

  @IsOptional()
  @IsNumber()
  max_active_deals?: number = 5;

  @IsOptional()
  @IsNumber()
  initial_balance?: number = 5000;

  @IsOptional()
  @IsNumber()
  base_order_size?: number = 1000;

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsArray()
  pairs?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  entry_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  exit_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bullish_entry_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bearish_entry_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bullish_exit_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bearish_exit_conditions?: StrategyCondition[];
}

export class SaveStrategyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  entry_conditions: StrategyCondition[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  exit_conditions: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bullish_entry_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bearish_entry_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bullish_exit_conditions?: StrategyCondition[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  bearish_exit_conditions?: StrategyCondition[];
}

