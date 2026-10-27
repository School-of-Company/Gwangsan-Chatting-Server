import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { SpanKind } from '@opentelemetry/api';
import Redis from 'ioredis';
import { RedisStreamPublisher } from './redis-stream.publisher';
import { MetricsService } from '../telemetry/metrics.service';
import { installInMemoryTracing } from '../telemetry/in-memory-tracing.helper-spec';

function fieldsOf(xaddArgs: string[]): Record<string, string> {
  // xadd(key, 'MAXLEN', '~', '10000', '*', ...fields)
  const flat = xaddArgs.slice(5);
  const fields: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
  return fields;
}

async function publishCount(metrics: MetricsService, outcome: string) {
  const metric = await metrics.registry
    .getSingleMetric('gwangsan_chat_publish_duration_seconds')!
    .get();
  return (
    metric.values.find(
      (v) =>
        (v as { metricName?: string }).metricName ===
          'gwangsan_chat_publish_duration_seconds_count' &&
        v.labels.outcome === outcome,
    )?.value ?? 0
  );
}

describe('RedisStreamPublisher', () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let xadd: jest.Mock;
  let metrics: MetricsService;
  let publisher: RedisStreamPublisher;
  const business = { messageId: '1', roomId: '7', content: '본문' };

  beforeEach(() => {
    tracing = installInMemoryTracing();
    xadd = jest.fn().mockResolvedValue('1-0');
    metrics = new MetricsService();
    publisher = new RedisStreamPublisher({ xadd } as unknown as Redis, metrics);
  });

  afterEach(() => tracing.uninstall());

  it('PRODUCER span 의 컨텍스트를 traceparent 로 싣고 기존 필드는 그대로 둔다', async () => {
    const parent = trace.getTracer('t').startSpan('socket.io sendMessage');
    await context.with(trace.setSpan(ROOT_CONTEXT, parent), () =>
      publisher.publish('chat:room:7:messages', business),
    );
    parent.end();

    const fields = fieldsOf(xadd.mock.calls[0] as string[]);
    const producer = tracing.exporter
      .getFinishedSpans()
      .find((s) => s.kind === SpanKind.PRODUCER)!;

    expect(fields).toMatchObject(business);
    expect(fields.traceparent).toBe(
      `00-${producer.spanContext().traceId}-${producer.spanContext().spanId}-01`,
    );
    expect(producer.parentSpanContext?.spanId).toBe(
      parent.spanContext().spanId,
    );
    expect(JSON.stringify(producer.attributes)).not.toContain('본문');
    expect(JSON.stringify(producer.attributes)).not.toContain(':7:');
  });

  it('baggage 는 스트림 레코드에 싣지 않는다', async () => {
    const bag = propagation.createBaggage({ userId: { value: 'secret-42' } });
    await context.with(propagation.setBaggage(ROOT_CONTEXT, bag), () =>
      publisher.publish('chat:room:7:messages', business),
    );

    const fields = fieldsOf(xadd.mock.calls[0] as string[]);
    expect(Object.keys(fields).sort()).toEqual(
      [...Object.keys(business), 'traceparent'].sort(),
    );
    expect(JSON.stringify(fields)).not.toContain('secret-42');
  });

  it('SDK 가 꺼져 있으면(롤백) 추적 필드 없이 기존 형식 그대로 발행한다', async () => {
    tracing.uninstall();

    await publisher.publish('chat:room:7:messages', business);

    expect(fieldsOf(xadd.mock.calls[0] as string[])).toEqual(business);
    expect(await publishCount(metrics, 'success')).toBe(1);
  });

  it('XADD 실패는 원래 에러로 다시 던지고 error 로 기록하며 컨텍스트를 복원한다', async () => {
    const boom = new Error(
      'READONLY You can not write against a read only replica.',
    );
    xadd.mockRejectedValue(boom);

    await expect(
      publisher.publish('chat:room:7:messages', business),
    ).rejects.toBe(boom);

    expect(await publishCount(metrics, 'error')).toBe(1);
    expect(await publishCount(metrics, 'success')).toBe(0);
    expect(tracing.exporter.getFinishedSpans()[0].status.code).toBe(2);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('MAXLEN ~ 10000 정책은 바뀌지 않는다', async () => {
    await publisher.publish('chat:room:7:messages', business);
    expect((xadd.mock.calls[0] as string[]).slice(0, 5)).toEqual([
      'chat:room:7:messages',
      'MAXLEN',
      '~',
      '10000',
      '*',
    ]);
  });
});
