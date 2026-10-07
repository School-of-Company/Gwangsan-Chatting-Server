import {
  Injectable,
  UnauthorizedException,
  UnsupportedMediaTypeException,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { LoggingUtil } from '../common/logging.util';

// Spring serializes Long message IDs as JSON numbers, beyond JS safe integers.
// Consume complete string tokens so message content cannot be mistaken for a key.
export function parseInternalChatBody(raw: Buffer): unknown {
  const json = raw
    .toString('utf8')
    .replace(
      /"(?:\\.|[^"\\])*"(?:\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?/g,
      (token: string, number: string | undefined) => {
        if (number === undefined || !/^-?\d+$/.test(number)) return token;
        const colon = token.lastIndexOf(':');
        const key: unknown = JSON.parse(token.slice(0, colon).trim());
        return key === 'messageId'
          ? `${token.slice(0, colon + 1)}"${number}"`
          : token;
      },
    );
  return JSON.parse(json);
}

@Injectable()
export class InternalChatGuard implements CanActivate {
  private readonly secret: Buffer;

  constructor(config: ConfigService) {
    this.secret = Buffer.from(config.getOrThrow<string>('INTERNAL_API_SECRET'));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const received = Buffer.from(request.get('x-internal-secret') ?? '');
    if (
      received.length === 0 ||
      received.length !== this.secret.length ||
      !timingSafeEqual(received, this.secret)
    ) {
      LoggingUtil.error(
        'InternalChatGuard',
        `내부 API 인증 실패: path=${request.path}`,
      );
      throw new UnauthorizedException('유효하지 않은 내부 인증 정보입니다.');
    }
    if (!request.is('application/json')) {
      throw new UnsupportedMediaTypeException(
        'Content-Type must be application/json',
      );
    }
    if (request.rawBody) {
      request.body = parseInternalChatBody(request.rawBody);
    }
    return true;
  }
}
