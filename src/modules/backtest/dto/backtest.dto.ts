import {
  IsString,
  IsNumber,
  IsArray,
  IsOptional,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ConditionSubfields {
  @IsOptional()
  @IsString()
  Timeframe?: string = '1m';

  @IsOptional()
  @IsString()
  Condition?: string;

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
  'MACD Trigger'?: string;

  @IsOptional()
  @IsString()
  'Line Trigger'?: string;

  @IsOptional()
  @IsString()
  'Stochastic Preset'?: string = '14,3,3';

  @IsOptional()
  @IsString()
  'K Condition'?: string;

  @IsOptional()
  @IsNumber()
  'K Signal Value'?: number;

  @IsOptional()
  @IsString()
  'PSAR Preset'?: string = '0.02,0.2';

  // For IMMEDIATE indicator (always true)
  @IsOptional()
  @IsString()
  action?: string;

  // For TIME_ELAPSED indicator (exit after X minutes)
  @IsOptional()
  @IsNumber()
  minutes?: number;
}

export class StrategyCondition {
  @IsString()
  indicator: string;

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
  initial_balance?: number = 10000;

  @IsOptional()
  @IsNumber()
  base_order_size?: number = 1000;

  @IsOptional()
  @IsNumber()
  trading_fee?: number = 0.1;

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsArray()
  pairs?: string[];

  // Entry/Exit Conditions
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

  // Safety Orders (DCA)
  @IsOptional()
  @IsBoolean()
  safety_order_toggle?: boolean;

  @IsOptional()
  @IsNumber()
  safety_order_size?: number;

  @IsOptional()
  @IsNumber()
  price_deviation?: number;

  @IsOptional()
  @IsNumber()
  max_safety_orders_count?: number;

  @IsOptional()
  @IsNumber()
  safety_order_volume_scale?: number;

  @IsOptional()
  @IsNumber()
  safety_order_step_scale?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyCondition)
  safety_conditions?: StrategyCondition[];

  // Take Profit
  @IsOptional()
  @IsBoolean()
  price_change_active?: boolean;

  @IsOptional()
  @IsBoolean()
  conditions_active?: boolean;

  @IsOptional()
  @IsString()
  take_profit_type?: string;

  @IsOptional()
  @IsNumber()
  target_profit?: number;

  @IsOptional()
  @IsNumber()
  take_profit?: number;

  @IsOptional()
  @IsBoolean()
  trailing_toggle?: boolean;

  @IsOptional()
  @IsNumber()
  trailing_deviation?: number;

  @IsOptional()
  @IsBoolean()
  minprof_toggle?: boolean;

  @IsOptional()
  @IsNumber()
  minimal_profit?: number;

  // Stop Loss
  @IsOptional()
  @IsBoolean()
  stop_loss_toggle?: boolean;

  @IsOptional()
  @IsNumber()
  stop_loss_value?: number;

  @IsOptional()
  @IsNumber()
  stop_loss?: number;

  @IsOptional()
  @IsNumber()
  stop_loss_timeout?: number;

  // Other settings
  @IsOptional()
  @IsNumber()
  reinvest_profit?: number;

  @IsOptional()
  @IsNumber()
  risk_reduction?: number;

  @IsOptional()
  @IsNumber()
  min_daily_volume?: number;

  @IsOptional()
  @IsNumber()
  cooldown_between_deals?: number;

  @IsOptional()
  @IsNumber()
  close_deal_after_timeout?: number;

  // Legacy fields
  @IsOptional()
  trailing_stop?: boolean;

  @IsOptional()
  @IsNumber()
  trailing_stop_percent?: number;

  @IsOptional()
  use_safety_orders?: boolean;

  @IsOptional()
  @IsNumber()
  safety_orders_count?: number;

  @IsOptional()
  @IsNumber()
  safety_order_deviation?: number;
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
