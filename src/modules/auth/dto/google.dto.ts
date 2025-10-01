import { IsEmail, IsString, IsOptional } from 'class-validator';

export class GoogleProfileDto {
  @IsString()
  id!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  picture?: string;
}
