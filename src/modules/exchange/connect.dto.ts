import { IsString, IsBoolean, IsOptional } from 'class-validator';

export class ConnectDto {
  @IsString()
  exchange!: string;

  @IsString()
  apiKey!: string;

  @IsString()
  secret!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsBoolean()
  testnet?: boolean = true;
}
