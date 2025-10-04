import { Controller, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SseService } from './sse.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('sse')
export class SseController {
  constructor(private readonly sseService: SseService) {}

  @Sse('logs')
  logs(): Observable<{
    data: {
      ts: number;
      msg: string;
    };
  }> {
    return this.sseService.getStream();
  }
}
