import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Principal } from '../auth/principal.js';
import type { UsageChannel } from './usage.constants.js';
import { UsageCollector } from './usage-request-context.js';

interface Req {
  path?: string;
  principal?: Principal;
}
interface Res {
  statusCode: number;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

export function channelOf(principal: Principal): UsageChannel {
  return principal.kind === 'admin' ? 'ui' : 'api';
}

/**
 * Opens a request-local usage context for authenticated REST requests (`ui` for the admin session, `api` for a key).
 * Services stage accesses while the handler runs; this interceptor is the transport boundary that decides: they are
 * committed (an in-memory enqueue, no I/O) only when the response finished with a 2xx status, so denied, failed and
 * aborted requests (including a download the client dropped) count nothing. `/mcp` has its own boundary in McpService.
 */
@Injectable()
export class UsageAccessInterceptor implements NestInterceptor {
  constructor(@Inject(UsageCollector) private readonly usage: UsageCollector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    const path = req.path ?? '';
    if (!req.principal || path === '/mcp' || path.startsWith('/mcp/')) return next.handle();
    const channel = channelOf(req.principal);

    return new Observable((subscriber) => {
      let subscription: { unsubscribe(): void } | undefined;
      this.usage.run(channel, (ctx) => {
        try {
          res.once('finish', () => (res.statusCode >= 200 && res.statusCode < 300 ? this.usage.commit(ctx) : this.usage.discard(ctx)));
          res.once('close', () => this.usage.discard(ctx));
        } catch {
          /* best effort */
        }
        // Subscribing here runs the handler inside the context, so every await below it sees it.
        subscription = next.handle().subscribe(subscriber);
      });
      return () => subscription?.unsubscribe();
    });
  }
}
