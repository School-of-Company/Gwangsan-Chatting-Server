import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { LoggingUtil } from '../common/logging.util';
import { resolveMetricsPort } from './telemetry.config';

/** 계약 버킷(초). */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export const SOCKET_EVENTS = [
  'connect',
  'disconnect',
  'joinRoom',
  'leaveRoom',
  'sendMessage',
  'other',
] as const;
export type SocketEventLabel = (typeof SOCKET_EVENTS)[number];

/** success: 처리 완료, rejected: 클라이언트 입력/권한 거부, error: 서버 측 실패, ignored: 처리기 없는 이벤트. */
export type EventOutcome = 'success' | 'rejected' | 'error' | 'ignored';
export type PublishOutcome = 'success' | 'error';

/**
 * Prometheus 지표 단독 소유자. 공개 앱 포트가 아닌 내부 리스너(기본 9464)의 /metrics 로만 노출한다.
 * 라벨은 위 고정 목록만 쓴다(방/회원/메시지/trace ID 금지).
 */
@Injectable()
export class MetricsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly registry = new Registry();
  private connectionCount: () => number = () => 0;
  private server?: Server;

  private readonly events = new Counter({
    name: 'gwangsan_chat_events_total',
    help: 'Socket.IO events handled, by event and outcome',
    labelNames: ['event', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly eventDuration = new Histogram({
    name: 'gwangsan_chat_event_duration_seconds',
    help: 'Socket.IO event handler duration',
    labelNames: ['event'] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly publishDuration = new Histogram({
    name: 'gwangsan_chat_publish_duration_seconds',
    help: 'Redis Stream XADD duration, by outcome',
    labelNames: ['outcome'] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  constructor() {
    const connections: Gauge = new Gauge({
      name: 'gwangsan_chat_connections',
      help: 'Currently connected Socket.IO clients on /api/chat',
      registers: [this.registry],
      collect: () => connections.set(this.connectionCount()),
    });
    // 프로세스 시작 이후 실제로 0 인 조합을 미리 노출해 "없음"과 "0"을 구분한다.
    for (const event of SOCKET_EVENTS) {
      for (const outcome of ['success', 'rejected', 'error'] as const) {
        this.events.labels(event, outcome).inc(0);
      }
    }
    this.events.labels('other', 'ignored').inc(0);
    this.publishDuration.zero({ outcome: 'success' });
    this.publishDuration.zero({ outcome: 'error' });
    collectDefaultMetrics({ register: this.registry });
  }

  /** 게이지는 스크레이프 시점의 실제 소켓 수를 읽는다(증감 누적 오차 없음). */
  trackConnections(count: () => number): void {
    this.connectionCount = count;
  }

  recordEvent(
    event: SocketEventLabel,
    outcome: EventOutcome,
    durationSeconds?: number,
  ): void {
    this.events.labels(event, outcome).inc();
    if (durationSeconds !== undefined) {
      this.eventDuration.labels(event).observe(durationSeconds);
    }
  }

  recordPublish(outcome: PublishOutcome, durationSeconds: number): void {
    this.publishDuration.labels(outcome).observe(durationSeconds);
  }

  /** 실제로 바인딩된 포트. 리스너가 없으면 null. */
  get port(): number | null {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return address?.port ?? null;
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = resolveMetricsPort();
    if (port === null) return;
    const host = process.env.METRICS_HOST ?? '0.0.0.0';

    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': this.registry.contentType });
          res.end(body);
        })
        .catch((error: unknown) => {
          LoggingUtil.error('MetricsService', '메트릭 직렬화 실패', error);
          res.writeHead(500).end();
        });
    });

    // 모니터링 포트 문제로 채팅 서비스가 죽으면 안 되므로 바인딩 실패는 로그만 남긴다.
    await new Promise<void>((resolve) => {
      server.once('error', (error) => {
        LoggingUtil.error('MetricsService', '메트릭 리스너 시작 실패', error);
        resolve();
      });
      server.listen(port, host, () => {
        this.server = server;
        LoggingUtil.log(
          'MetricsService',
          `메트릭 리스너 시작: port=${this.port}`,
        );
        resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
