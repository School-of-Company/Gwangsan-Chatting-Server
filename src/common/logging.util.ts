import { createLogger, format, transports } from 'winston';
import 'winston-daily-rotate-file';

const logger = createLogger({
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(
      ({ timestamp, level, message }) =>
        `[${String(timestamp)}] [${level.toUpperCase()}] ${String(message)}`,
    ),
  ),
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

export class LoggingUtil {
  static log(context: string, message: string): void {
    logger.info(`[${context}] ${message}`);
  }

  static error(context: string, message: string, error?: unknown): void {
    const errorStr = error instanceof Error ? ` | ${error.message}` : '';
    logger.error(`[${context}] ${message}${errorStr}`);
  }
}
