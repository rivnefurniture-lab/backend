import { Module } from '@nestjs/common';
import { TradesController } from './trades.controller';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [TradesController],
  providers: [PrismaService],
})
export class TradesModule {}

