import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import {
  context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorage } from 'async_hooks';
import { from, lastValueFrom, Observable } from 'rxjs';
import {
  EventOutcome,
  MetricsService,
  SOCKET_EVENTS,
  SocketEventLabel,
} from './metrics.service';
import { recordSpanError } from './span-privacy';

interface EventScope {
  span: Span;
  failure?: { outcome: EventOutcome; error: unknown };
}

// OTel 컨텍스트와 별개로 두어 SDK 가 꺼져 있어도(롤백) 결과 메트릭이 정확하게 남는다.
const eventScope = new AsyncLocalStorage<EventScope>();

export function toEventLabel(event: unknown): SocketEventLabel {
  return SOCKET_EVENTS.includes(event as SocketEventLabel) && event !== 'other'
    ? (event as SocketEventLabel)
    : 'other';
}

function classify(error: unknown): EventOutcome {
  if (error instanceof WsException) return 'rejected';
  if (error instanceof HttpException && error.getStatus() < 500)
    return 'rejected';
  return 'error';
}

/**
 * 핸들러가 직접 잡아 클라이언트에 알린 실패를 현재 이벤트 결과에 반영한다.
 * (예: sendMessage 는 실패 시 throw 대신 'error' 이벤트를 보낸다.)
 */
export function markSocketEventFailed(error: unknown): void {
  const scope = eventScope.getStore();
  if (scope) scope.failure = { outcome: classify(error), error };
}

/**
 * Socket.IO 이벤트 하나를 짧은 루트 span 하나로 감싼다.
 * 클라이언트가 trace 컨텍스트를 보내지 않으므로 활성 컨텍스트와 무관하게 새 trace 를 시작하고,
 * 끝나면 이전 컨텍스트로 돌아간다(연결 수명 span·컨텍스트 누수 방지).
 */
export async function traceSocketEvent<T>(
  metrics: MetricsService,
  event: SocketEventLabel,
  handler: () => T | Promise<T>,
): Promise<T> {
  const span = trace.getTracer('gwangsan-chat.socket-io').startSpan(
    `socket.io ${event}`,
    {
      root: true,
      kind: SpanKind.SERVER,
      attributes: {
        'messaging.system': 'socket.io',
        'socket.io.event': event,
      },
    },
    ROOT_CONTEXT,
  );
  const scope: EventScope = { span };
  const startedAt = performance.now();
  try {
    return await eventScope.run(scope, () =>
      context.with(trace.setSpan(ROOT_CONTEXT, span), handler),
    );
  } catch (error) {
    scope.failure = { outcome: classify(error), error };
    throw error;
  } finally {
    const outcome = scope.failure?.outcome ?? 'success';
    if (scope.failure) {
      recordSpanError(span, scope.failure.error, outcome === 'error');
    }
    span.setAttribute('gwangsan.outcome', outcome);
    span.end();
    metrics.recordEvent(event, outcome, (performance.now() - startedAt) / 1000);
  }
}

/** @SubscribeMessage 핸들러용. 파이프 검증 실패도 핸들러 실행 범위 안에서 잡힌다. */
@Injectable()
export class SocketEventInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'ws') return next.handle();
    const event = toEventLabel(ctx.switchToWs().getPattern());
    return from(
      traceSocketEvent(this.metrics, event, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}
