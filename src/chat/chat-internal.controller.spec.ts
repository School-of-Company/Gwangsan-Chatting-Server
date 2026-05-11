import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatInternalController } from './chat-internal.controller';
import { ChatNotificationService } from './chat-notification.service';

describe('ChatInternalController', () => {
  let controller: ChatInternalController;
  let chatNotificationService: jest.Mocked<ChatNotificationService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    chatNotificationService = {
      broadcastTransactionStateChanged: jest.fn(),
      setServer: jest.fn(),
    } as unknown as jest.Mocked<ChatNotificationService>;
    configService = {
      getOrThrow: jest.fn().mockReturnValue('test-secret'),
    } as unknown as jest.Mocked<ConfigService>;
    controller = new ChatInternalController(
      chatNotificationService,
      configService,
    );
  });

  it('시크릿이 맞으면 거래 상태 이벤트를 발행한다', () => {
    const payload = {
      roomId: 1,
      productId: 2,
      isCompleted: true,
      createdAt: '2026-05-11T00:00:00.000Z',
    };

    expect(
      controller.publishTransactionStateChanged('test-secret', payload),
    ).toEqual({ ok: true });
    /* eslint-disable @typescript-eslint/unbound-method */
    expect(
      chatNotificationService.broadcastTransactionStateChanged,
    ).toHaveBeenCalledWith(payload);
    /* eslint-enable @typescript-eslint/unbound-method */
  });

  it('시크릿이 다르면 401을 던진다', () => {
    expect(() =>
      controller.publishTransactionStateChanged('wrong-secret', {
        roomId: 1,
        productId: 2,
        isCompleted: true,
        createdAt: '2026-05-11T00:00:00.000Z',
      }),
    ).toThrow(UnauthorizedException);
  });
});
