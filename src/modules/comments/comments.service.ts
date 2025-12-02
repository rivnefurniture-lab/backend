import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommentDto, CreateCommentDto } from './commentDTO';

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService) {}

  findAll(): Promise<Array<CommentDto>> {
    return this.prisma.comment.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  create(data: CreateCommentDto) {
    return this.prisma.comment.create({ data });
  }
}
