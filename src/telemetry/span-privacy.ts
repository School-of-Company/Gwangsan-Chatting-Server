import { Span, SpanStatusCode } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span as SdkSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { sanitizeErrorMessage } from '../common/sanitize.util';

/** URL 쿼리 값을 담을 수 있는 HTTP semconv 속성(구/신 규약). */
const URL_ATTRIBUTES = ['http.url', 'http.target', 'url.full'] as const;

/**
 * 종료 직전 span 의 URL 쿼리를 통째로 지운다. 계측 라이브러리 기본 마스킹은 일부 키만 다루고
 * 오류 경로에서는 사용자 훅이 불리지 않으므로, 모든 span 이 지나는 프로세서에서 처리한다.
 */
export class QueryRedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: SdkSpan): void {
    const attributes = (span as unknown as ReadableSpan).attributes;
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === 'string' && value.includes('?')) {
        span.setAttribute(key, value.slice(0, value.indexOf('?')));
      }
    }
    if (attributes['url.query'] !== undefined) {
      span.setAttribute('url.query', 'REDACTED');
    }
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** 예외를 span 에 남기되 본문/토큰이 섞일 수 있는 메시지는 정리하고 스택은 싣지 않는다. */
export function recordSpanError(
  span: Span,
  error: unknown,
  markStatus = true,
): void {
  const type = error instanceof Error ? error.name : typeof error;
  span.recordException({
    name: type,
    message:
      error instanceof Error ? sanitizeErrorMessage(error.message) : undefined,
  });
  if (markStatus) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: type });
  }
}
