import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  author?: string;

  @IsString()
  @MaxLength(500)
  text!: string;

  @IsOptional()
  @IsString()
  photo?: string;
}

export class CommentDto {
  id!: number;
  author?: string | null;
  text!: string;
  photo?: string | null;
  createdAt!: Date;
}
