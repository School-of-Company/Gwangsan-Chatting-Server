/**
 * OpenTelemetry Node SDK 사전 로드.
 *
 * http/ioredis 를 패치하려면 Nest 와 ioredis 보다 먼저 실행돼야 한다.
 *   node --require ./dist/src/instrumentation.js dist/src/main.js
 * main.ts 첫 줄에서도 import 하므로 --require 없이 띄워도 동작한다(같은 경로라 한 번만 실행).
 *
 * 트레이스만 OTLP HTTP 로 내보낸다. 메트릭은 prom-client(/metrics, 9464)가 단독 소유하고
 * OTel 메트릭/로그 exporter 는 env 와 무관하게 끈다. OTEL_SDK_DISABLED=true 로 롤백한다.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { IncomingMessage } from 'http';
import {
  isIgnoredIncomingPath,
  resolveEnvironment,
  resolveSampleRatio,
  resolveServiceName,
  resolveTracesUrl,
} from './telemetry/telemetry.config';
import { QueryRedactingSpanProcessor } from './telemetry/span-privacy';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: resolveServiceName(),
    'deployment.environment.name': resolveEnvironment(),
  }),
  // ponytail: 호스트/프로세스 detector 는 명령행 인자 등까지 실어 보내므로 env 만 둔다.
  resourceDetectors: [envDetector],
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(resolveSampleRatio()),
  }),
  // 마스킹이 먼저 돌아야 배치 큐에 쿼리 문자열이 들어가지 않는다. 큐/배치 크기는 SDK 기본(상한 있음).
  spanProcessors: [
    new QueryRedactingSpanProcessor(),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: resolveTracesUrl() })),
  ],
  metricReaders: [],
  logRecordProcessors: [],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req: IncomingMessage) =>
        isIgnoredIncomingPath(req.url),
    }),
    new IORedisInstrumentation({
      // 키(auth:cache:<회원>)와 값(채팅 본문)이 남지 않게 명령 이름만 기록한다.
      dbStatementSerializer: (cmdName) => cmdName,
    }),
  ],
});

sdk.start();

/** 대기 중인 span 을 내보내고 종료한다. 수집기가 죽어 있어도 종료를 막지 않도록 시간 제한을 둔다. */
export async function shutdownTelemetry(timeoutMs = 5000): Promise<void> {
  await Promise.race([
    sdk.shutdown().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}
