import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [SubscriptionModule],
  controllers: [UserController],
  providers: [PrismaService],
})
export class UserModule {}
