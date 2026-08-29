import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { LoggingUtil } from '../common/logging.util';

export interface TransactionStateChangedPayload {
  roomId: number;
  targetMemberId?: number;
  productId: number;
  isCompleted: boolean;
  isReserved?: boolean;
  createdAt: string;
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
