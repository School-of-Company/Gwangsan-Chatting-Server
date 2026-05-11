import { UnauthorizedException } from '@nestjs/common';
import { ChatInternalController } from './chat-internal.controller';
import { ChatNotificationService } from './chat-notification.service';

describe('ChatInternalController', () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;
  let controller: ChatInternalController;
  let chatNotificationService: jest.Mocked<ChatNotificationService>;

  beforeEach(() => {
    process.env.INTERNAL_API_SECRET = 'test-secret';
    chatNotificationService = {
      broadcastTransactionStateChanged: jest.fn(),
      setServer: jest.fn(),
    } as unknown as jest.Mocked<ChatNotificationService>;
    controller = new ChatInternalController(chatNotificationService);
  });

  afterAll(() => {
    process.env.INTERNAL_API_SECRET = originalSecret;
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
