import { Module } from '@nestjs/common';
import { ExchangeService } from './exchange.service';
import { ExchangeController } from './exchange.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  providers: [ExchangeService, PrismaService],
  controllers: [ExchangeController],
  exports: [ExchangeService],
})
export class ExchangeModule {}
