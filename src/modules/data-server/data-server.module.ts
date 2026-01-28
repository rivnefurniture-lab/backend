import { Module, Global } from '@nestjs/common';
import { DataServerService } from './data-server.service';

@Global()
@Module({
  providers: [DataServerService],
  exports: [DataServerService],
})
export class DataServerModule {}
