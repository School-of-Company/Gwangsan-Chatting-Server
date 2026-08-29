import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { LoggingUtil } from '../common/logging.util';

export interface TransactionStateChangedPayload {
  roomId: number;
  /** @deprecated 방 단위 상태이므로 수신 대상을 좁히지 않는다. 하위 호환용. */
  targetMemberId?: number;
  productId: number;
  isCompleted: boolean;
  isReserved?: boolean;
  /** 거래 요청 생성 시각. 활성 요청이 없으면 null. */
  createdAt?: string | null;
  /** 완료 요청을 먼저 한 쪽이 판매자인지. 대기 중인 요청이 없으면 null. */
  requestedBySeller?: boolean | null;
}

@Injectable()
export class ChatNotificationService {
  private server?: Server;

  setServer(server: Server): void {
    this.server = server;
  }

  broadcastTransactionStateChanged(
    payload: TransactionStateChangedPayload,
  ): void {
    if (!this.server) {
      LoggingUtil.error(
        'ChatNotificationService',
        `Socket server가 초기화되지 않아 거래 상태 이벤트를 발행할 수 없습니다: roomId=${payload.roomId}, productId=${payload.productId}`,
      );
      return;
    }

    // 거래 상태는 방 단위 상태이므로 참여자 양쪽 모두에게 보낸다.
    // targetMemberId 로 한쪽만 고르면 행위자 본인 또는 상대 중 한쪽 화면이 갱신되지 않는다.
    const targetRoom = `roomId=${payload.roomId}`;

    this.server.in(targetRoom).emit('transactionStateChanged', payload);

    LoggingUtil.log(
      'ChatNotificationService',
      `거래 상태 이벤트 발행: targetRoom=${targetRoom}, roomId=${payload.roomId}, productId=${payload.productId}, isCompleted=${payload.isCompleted}`,
    );
  }
}
