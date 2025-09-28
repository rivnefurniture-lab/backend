import { Controller, Get } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CommentDto } from './commentDTO';

@Controller('comments')
export class CommentsController {
  constructor(private commentsService: CommentsService) {}

  @Get()
  findAll(): Promise<Array<CommentDto>> {
    return this.commentsService.findAll();
  }
}
