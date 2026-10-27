import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { BadRequestException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { installInMemoryTracing } from './in-memory-tracing.helper-spec';
import { MetricsService } from './metrics.service';
import {
  markSocketEventFailed,
  toEventLabel,
  traceSocketEvent,
} from './socket-event';

async function counterValue(
  metrics: MetricsService,
  event: string,
  outcome: string,
): Promise<number> {
  const metric = await metrics.registry
    .getSingleMetric('gwangsan_chat_events_total')!
    .get();
  return (
    metric.values.find(
      (v) => v.labels.event === event && v.labels.outcome === outcome,
    )?.value ?? 0
  );
}

describe('traceSocketEvent', () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let metrics: MetricsService;

  beforeEach(() => {
    tracing = installInMemoryTracing();
    metrics = new MetricsService();
  });

  afterEach(() => tracing.uninstall());

  it('이벤트마다 짧은 루트 span 하나를 만들고 끝낸다', async () => {
    await traceSocketEvent(metrics, 'sendMessage', () => Promise.resolve());

    const spans = tracing.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('socket.io sendMessage');
    expect(spans[0].parentSpanContext).toBeUndefined();
    expect(await counterValue(metrics, 'sendMessage', 'success')).toBe(1);
  });

  it('다른 span 이 활성 상태여도 부모로 삼지 않는다(소켓 수명 컨텍스트 누수 방지)', async () => {
    const outer = trace.getTracer('t').startSpan('connection-lifetime');
    await context.with(trace.setSpan(ROOT_CONTEXT, outer), () =>
      traceSocketEvent(metrics, 'joinRoom', () => undefined),
    );
    outer.end();

    const event = tracing.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'socket.io joinRoom')!;
    expect(event.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  });

  it('동시 이벤트는 서로 다른 trace 를 갖고, 끝난 뒤 활성 span 이 남지 않는다', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const a = traceSocketEvent(metrics, 'sendMessage', async () => {
      await gate;
      seen.push(trace.getActiveSpan()!.spanContext().traceId);
    });
    const b = traceSocketEvent(metrics, 'sendMessage', () => {
      seen.push(trace.getActiveSpan()!.spanContext().traceId);
      release();
    });
    await Promise.all([a, b]);

    expect(new Set(seen).size).toBe(2);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('핸들러가 던지면 원래 에러를 다시 던지고 error 로 기록한다', async () => {
    const boom = new Error('redis down');

    await expect(
      traceSocketEvent(metrics, 'sendMessage', () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    const span = tracing.exporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).toContain('exception');
    expect(await counterValue(metrics, 'sendMessage', 'error')).toBe(1);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('WsException·검증 실패는 rejected 로 분류하고 span 을 ERROR 로 두지 않는다', async () => {
    await expect(
      traceSocketEvent(metrics, 'joinRoom', () => {
        throw new WsException('참여 중인 채팅방이 아닙니다');
      }),
    ).rejects.toBeInstanceOf(WsException);
    await expect(
      traceSocketEvent(metrics, 'sendMessage', () => {
        throw new BadRequestException(['content must be a string']);
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await counterValue(metrics, 'joinRoom', 'rejected')).toBe(1);
    expect(await counterValue(metrics, 'sendMessage', 'rejected')).toBe(1);
    for (const span of tracing.exporter.getFinishedSpans()) {
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    }
  });

  it('핸들러가 잡아서 처리한 실패도 markSocketEventFailed 로 결과에 반영된다', async () => {
    await traceSocketEvent(metrics, 'sendMessage', () => {
      markSocketEventFailed(new Error('stream publish failed'));
    });

    expect(await counterValue(metrics, 'sendMessage', 'error')).toBe(1);
    expect(await counterValue(metrics, 'sendMessage', 'success')).toBe(0);
  });

  it('예외 이벤트에 채팅 본문·토큰이 실리지 않는다', async () => {
    const error = new Error(
      'failed body={"content":"비밀"} ?token=abc Bearer eyJa.eyJb.sig',
    );

    await expect(
      traceSocketEvent(metrics, 'sendMessage', () => Promise.reject(error)),
    ).rejects.toBe(error);

    const exported = JSON.stringify(
      tracing.exporter.getFinishedSpans()[0].events,
    );
    expect(exported).not.toContain('abc');
    expect(exported).not.toContain('eyJb');
    expect(exported).not.toContain('비밀');
  });

  it('SDK 가 없어도(롤백) 메트릭은 기록된다', async () => {
    tracing.uninstall();

    await traceSocketEvent(metrics, 'leaveRoom', () => {
      markSocketEventFailed(new WsException('x'));
    });

    expect(await counterValue(metrics, 'leaveRoom', 'rejected')).toBe(1);
  });

  it('알 수 없는 이벤트 이름은 other 로 묶는다', () => {
    expect(toEventLabel('sendMessage')).toBe('sendMessage');
    expect(toEventLabel('room:12345')).toBe('other');
    expect(toEventLabel(undefined)).toBe('other');
  });
});
