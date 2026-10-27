import { Inject, Injectable } from '@nestjs/common';
import {
  context,
  defaultTextMapSetter,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import Redis from 'ioredis';
import { MetricsService } from '../telemetry/metrics.service';
import { recordSpanError } from '../telemetry/span-privacy';

// 전역 전파기는 baggage 도 싣는다. 스트림 레코드에는 traceparent/tracestate 만 넣는다.
const traceContext = new W3CTraceContextPropagator();

@Injectable()
export class RedisStreamPublisher {
  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 스트림에 레코드를 추가한다. 선택 필드 traceparent/tracestate 는 기존 스프링 컨슈머가
   * 이름으로 필드를 읽으므로 무시되고, 새 컨슈머는 이를 부모로 CONSUMER span 을 잇는다.
   */
  async publish(
    streamKey: string,
    fields: Record<string, string>,
  ): Promise<string> {
    return trace.getTracer('gwangsan-chat.redis-stream').startActiveSpan(
      'chat.stream publish',
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'redis',
          'messaging.operation.type': 'send',
          'messaging.operation.name': 'xadd',
          // 방 번호가 든 실제 키 대신 템플릿만 남긴다.
          'messaging.destination.template': 'chat:room:{roomId}:messages',
        },
      },
      async (span) => {
        const carrier: Record<string, string> = {};
        traceContext.inject(context.active(), carrier, defaultTextMapSetter);
        const startedAt = performance.now();
        try {
          const id = (await this.client.xadd(
            streamKey,
            'MAXLEN',
            '~',
            '10000',
            '*',
            ...Object.entries({ ...fields, ...carrier }).flat(),
          )) as string;
          this.metrics.recordPublish(
            'success',
            (performance.now() - startedAt) / 1000,
          );
          return id;
        } catch (error) {
          this.metrics.recordPublish(
            'error',
            (performance.now() - startedAt) / 1000,
          );
          recordSpanError(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
