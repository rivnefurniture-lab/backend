import { IsString, IsBoolean } from 'class-validator';

export class ConnectDto {
  @IsString()
  exchange!: string;

  @IsString()
  apiKey!: string;

  @IsString()
  secret!: string;

  @IsString()
  password!: string;

  @IsBoolean()
  testnet?: boolean = true;
}
