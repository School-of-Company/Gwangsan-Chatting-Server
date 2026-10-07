import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import { LoggingUtil } from '../common/logging.util';
import { ChatInternalController } from './chat-internal.controller';
import { ChatNotificationService } from './chat-notification.service';
import {
  InternalChatGuard,
  parseInternalChatBody,
} from './internal-chat.guard';

describe('ChatInternalController authentication', () => {
  let app: INestApplication<App>;
  const broadcast = jest.fn();
  const payload = { roomId: 1, productId: 2, isCompleted: true };
  const paths = [
    'transaction-state',
    'message-updated',
    'message-deleted',
    'system-message',
  ] as const;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ChatInternalController],
      providers: [
        InternalChatGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ INTERNAL_API_SECRET: 'test-secret' }),
        },
        {
          provide: ChatNotificationService,
          useValue: { broadcastTransactionStateChanged: broadcast },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });

  beforeEach(() => broadcast.mockClear());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app.close());

  it('broadcasts transaction state when the secret is valid', async () => {
    await request(app.getHttpServer())
      .post('/api/internal/chat/transaction-state')
      .set('x-internal-secret', 'test-secret')
      .send(payload)
      .expect(201, { ok: true });
    expect(broadcast).toHaveBeenCalledWith(payload);
  });

  it.each(['', 'wrong', 'wrongsecret', 'test-secreX'])(
    'rejects secret %p before broadcasting',
    async (secret) => {
      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', secret)
        .send(payload)
        .expect(401);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid transaction payload when the secret is valid', async () => {
    await request(app.getHttpServer())
      .post('/api/internal/chat/transaction-state')
      .set('x-internal-secret', 'test-secret')
      .send({ ...payload, roomId: 0 })
      .expect(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  describe.each(paths)('%s request boundary', (path) => {
    it.each(['application/x-www-form-urlencoded', 'text/plain'])(
      'rejects non-JSON %s without broadcasting',
      async (contentType) => {
        await request(app.getHttpServer())
          .post(`/api/internal/chat/${path}`)
          .set('x-internal-secret', 'test-secret')
          .set('Content-Type', contentType)
          .send('roomId=1&productId=2&isCompleted=true')
          .expect(415);
        expect(broadcast).not.toHaveBeenCalled();
      },
    );

    it('logs authentication rejection without recording secrets or message content', async () => {
      const errorLog = jest
        .spyOn(LoggingUtil, 'error')
        .mockImplementation(() => {});
      const rejectedSecret = 'rejected-secret-value';
      const content = 'private-message-content';

      await request(app.getHttpServer())
        .post(`/api/internal/chat/${path}`)
        .set('x-internal-secret', rejectedSecret)
        .send({ ...payload, content })
        .expect(401);

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        'InternalChatGuard',
        expect.stringContaining(`/api/internal/chat/${path}`),
      );
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain(rejectedSecret);
      expect(logged).not.toContain('test-secret');
      expect(logged).not.toContain(content);
      expect(broadcast).not.toHaveBeenCalled();
    });
  });
});

describe('Spring Long JSON transport', () => {
  it('preserves exact IDs including nested and escaped keys without rewriting content', () => {
    const content = 'text "messageId":123 and \\ slash';
    const body = `{"messageId":9223372036854775807,"latestMessage":{"message\\u0049d":-9223372036854775808},"content":${JSON.stringify(content)}}`;
    expect(parseInternalChatBody(Buffer.from(body))).toEqual({
      messageId: '9223372036854775807',
      latestMessage: { messageId: '-9223372036854775808' },
      content,
    });
  });
});
