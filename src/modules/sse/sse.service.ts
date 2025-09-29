import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

@Injectable()
export class SseService {
  stream = new Subject<{ data: { ts: number; msg: string } }>();

  getStream() {
    return this.stream.asObservable();
  }

  send(message: string) {
    this.stream.next({ data: { ts: Date.now(), msg: message } });
  }
}
