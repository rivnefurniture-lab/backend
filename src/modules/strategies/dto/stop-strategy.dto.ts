import { IsString } from 'class-validator';

export class StopStrategyDto {
  @IsString()
  jobId!: string;
}
