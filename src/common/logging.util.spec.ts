import { context, trace } from '@opentelemetry/api';
import {
  buildLogRecord,
  JsonNestLogger,
  LoggingUtil,
  sanitizeErrorMessage,
} from './logging.util';
import { installInMemoryTracing } from '../telemetry/in-memory-tracing.helper-spec';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

describe('LoggingUtil', () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;

  beforeEach(() => {
    tracing = installInMemoryTracing();
  });

  afterEach(() => tracing.uninstall());

  it('기본 필드(timestamp, level, service, message)를 가진 JSON 레코드를 만든다', () => {
    const record = buildLogRecord('info', 'ChatGateway', '서버 초기화 완료');

    expect(record).toEqual(
      expect.objectContaining({
        level: 'info',
        service: 'gwangsan-chat',
        context: 'ChatGateway',
        message: '서버 초기화 완료',
      }),
    );
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    expect(record).not.toHaveProperty('trace_id');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('활성 span 이 있으면 trace_id 와 span_id 를 싣는다', () => {
    const span = trace.getTracer('test').startSpan('event');
    const record = context.with(trace.setSpan(context.active(), span), () =>
      buildLogRecord('info', 'Ctx', 'msg'),
    );
    span.end();

    expect(record.trace_id).toBe(span.spanContext().traceId);
    expect(record.span_id).toBe(span.spanContext().spanId);
  });

  it('span 이 끝난 뒤의 로그에는 이전 trace_id 가 남지 않는다', () => {
    const span = trace.getTracer('test').startSpan('event');
    context.with(trace.setSpan(context.active(), span), () => undefined);
    span.end();

    expect(buildLogRecord('info', 'Ctx', 'msg')).not.toHaveProperty('trace_id');
  });

  it('에러 메시지와 스택에서 토큰과 URL 쿼리를 지운다', () => {
    const error = new Error(
      `GET http://spring/api/chat/rooms?token=abc123&x=1 failed: Bearer ${JWT}`,
    );

    const record = buildLogRecord('error', 'Ctx', '실패', error);
    const serialized = JSON.stringify(record);

    expect(record.error_type).toBe('Error');
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('token=');
    expect(record.error_message).toContain('/api/chat/rooms');
    expect(record.stack).toEqual(expect.stringContaining('at '));
  });

  it('Error 가 아닌 값은 내용을 직렬화하지 않고 타입만 남긴다', () => {
    const record = buildLogRecord('error', 'Ctx', '실패', {
      content: '비밀 채팅 본문',
      token: 'Bearer secret',
    });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('비밀 채팅 본문');
    expect(serialized).not.toContain('secret');
    expect(record.error_type).toBe('Object');
  });

  it('긴 에러 메시지는 잘라낸다', () => {
    expect(sanitizeErrorMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(
      303,
    );
  });

  it('JSON 파싱 에러처럼 따옴표로 감싼 입력 조각을 지운다', () => {
    let error: unknown;
    try {
      JSON.parse('{"content":"비밀 채팅 본문"');
    } catch (e) {
      error = e;
    }
    expect(
      JSON.stringify(buildLogRecord('error', 'C', 'm', error)),
    ).not.toContain('비밀');
  });

  it('JWT 형태 문자열은 Bearer 접두사가 없어도 지운다', () => {
    expect(sanitizeErrorMessage(`invalid ${JWT}`)).not.toContain(JWT);
  });

  it('Nest 내부 예외 로그도 메시지를 에러 필드로만 정리해 남긴다', () => {
    const spy = jest.spyOn(LoggingUtil, 'error').mockImplementation(() => {});

    new JsonNestLogger().error(
      `payload {"content":"비밀"} Bearer ${JWT}`,
      'Error: x\n    at handler (/app/dist/src/x.js:1:1)',
      'WsExceptionsHandler',
    );

    const [context, message, error] = spy.mock.calls[0];
    const record = buildLogRecord('error', context, message, error);
    expect(record.context).toBe('WsExceptionsHandler');
    expect(JSON.stringify(record)).not.toContain('비밀');
    expect(JSON.stringify(record)).not.toContain(JWT);
    expect(record.stack).toContain('at handler');
    spy.mockRestore();
  });
});
