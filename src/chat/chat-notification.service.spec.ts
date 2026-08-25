import { ChatNotificationService } from './chat-notification.service';

describe('ChatNotificationService', () => {
  let service: ChatNotificationService;

  beforeEach(() => {
    service = new ChatNotificationService();
  });

  it('targetMemberId 룸에 transactionStateChanged 이벤트를 발행한다', () => {
    const emit = jest.fn();
    const inFn = jest.fn().mockReturnValue({ emit });
    const server = { in: inFn } as unknown as Parameters<
      ChatNotificationService['setServer']
    >[0];

    service.setServer(server);
    service.broadcastTransactionStateChanged({
      roomId: 7,
      targetMemberId: 11,
      productId: 33,
      isCompleted: true,
      createdAt: '2026-05-11T00:00:00.000Z',
    });

    expect(inFn).toHaveBeenCalledWith('memberId=11');
    expect(emit).toHaveBeenCalledWith('transactionStateChanged', {
      roomId: 7,
      targetMemberId: 11,
      productId: 33,
      isCompleted: true,
      createdAt: '2026-05-11T00:00:00.000Z',
    });
  });

  it('isReserved가 포함된 payload를 그대로 발행한다', () => {
    const emit = jest.fn();
    const inFn = jest.fn().mockReturnValue({ emit });
    const server = { in: inFn } as unknown as Parameters<
      ChatNotificationService['setServer']
    >[0];

    service.setServer(server);
    service.broadcastTransactionStateChanged({
      roomId: 7,
      targetMemberId: 11,
      productId: 33,
      isCompleted: false,
      isReserved: true,
      createdAt: '2026-05-11T00:00:00.000Z',
    });

    expect(emit).toHaveBeenCalledWith('transactionStateChanged', {
      roomId: 7,
      targetMemberId: 11,
      productId: 33,
      isCompleted: false,
      isReserved: true,
      createdAt: '2026-05-11T00:00:00.000Z',
    });
  });
});
