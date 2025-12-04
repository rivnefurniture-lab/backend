import { Module } from '@nestjs/common';
import { RefundController } from './refund.controller';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [RefundController],
  providers: [PrismaService],
})
export class RefundModule {}

