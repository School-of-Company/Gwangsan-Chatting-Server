import { LoggerService } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { createLogger, format, transports } from 'winston';
import 'winston-daily-rotate-file';
import { resolveServiceName } from '../telemetry/telemetry.config';
import { sanitizeErrorMessage } from './sanitize.util';

export { sanitizeErrorMessage };

/**
 * 한 줄 JSON 로그. Promtail 이 그대로 수집하고 Grafana 가 trace_id 로 Tempo 와 잇는다.
 * 요청/응답/채팅 본문, 토큰, 회원 식별자는 메시지에 넣지 않는다.
 */
const logger = createLogger({
  format: format.printf((info) => JSON.stringify(info.record)),
  transports: [
    new transports.Console(),
    new transports.DailyRotateFile({
      dirname: 'logs',
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      level: 'info',
    }),
    new transports.DailyRotateFile({
      dirname: 'logs',
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      level: 'error',
    }),
  ],
});

const SERVICE = resolveServiceName();
const MAX_STACK_FRAMES = 10;

export interface LogRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  service: string;
  context: string;
  message: string;
  trace_id?: string;
  span_id?: string;
  error_type?: string;
  error_message?: string;
  stack?: string;
}

function errorFields(
  error: unknown,
): Pick<LogRecord, 'error_type' | 'error_message' | 'stack'> {
  if (error instanceof Error) {
    // 스택 첫 줄은 메시지라 버리고 프레임만 남긴다.
    const frames = (error.stack ?? '')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .slice(0, MAX_STACK_FRAMES)
      .map((line) => sanitizeErrorMessage(line.trim()));
    return {
      error_type: error.name,
      error_message: sanitizeErrorMessage(error.message),
      ...(frames.length ? { stack: frames.join('\n') } : {}),
    };
  }
  // ponytail: Error 가 아닌 값은 본문이 담겼을 수 있어 타입 이름만 남긴다.
  const type =
    error === null
      ? 'null'
      : typeof error === 'object'
        ? (error.constructor?.name ?? 'Object')
        : typeof error;
  return { error_type: type };
}

export function buildLogRecord(
  level: LogRecord['level'],
  context: string,
  message: string,
  error?: unknown,
): LogRecord {
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    context,
    message,
  };
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext && isSpanContextValid(spanContext)) {
    record.trace_id = spanContext.traceId;
    record.span_id = spanContext.spanId;
  }
  return error === undefined ? record : { ...record, ...errorFields(error) };
}

export class LoggingUtil {
  static log(context: string, message: string): void {
    logger.info({ message, record: buildLogRecord('info', context, message) });
  }

  static warn(context: string, message: string): void {
    logger.warn({ message, record: buildLogRecord('warn', context, message) });
  }

  static error(context: string, message: string, error?: unknown): void {
    logger.error({
      message,
      record: buildLogRecord('error', context, message, error),
    });
  }
}

/**
 * Nest 내부 로그(기동, 처리되지 않은 예외)도 같은 JSON 형식으로 보낸다.
 * 예외 메시지는 본문이 섞일 수 있어 에러 필드로만 정리해 싣는다. debug/verbose 는 버린다.
 */
export class JsonNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    LoggingUtil.log(context ?? 'Nest', String(message));
  }

  warn(message: unknown, context?: string): void {
    LoggingUtil.warn(context ?? 'Nest', String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    const error =
      message instanceof Error ? message : new Error(String(message));
    if (!(message instanceof Error)) error.stack = stack;
    LoggingUtil.error(context ?? 'Nest', 'Nest 오류', error);
  }

  fatal(message: unknown, stack?: string, context?: string): void {
    this.error(message, stack, context);
  }

  debug(): void {}

  verbose(): void {}
}
