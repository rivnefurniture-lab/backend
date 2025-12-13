import { Module, Global } from '@nestjs/common';
import { HetznerService } from './hetzner.service';

@Global()
@Module({
  providers: [HetznerService],
  exports: [HetznerService],
})
export class HetznerModule {}
