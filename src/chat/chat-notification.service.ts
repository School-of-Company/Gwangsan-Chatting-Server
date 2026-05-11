import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { LoggingUtil } from '../common/logging.util';

export interface TransactionStateChangedPayload {
  roomId: number;
  productId: number;
  isCompleted: boolean;
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

    this.server
      .in(`roomId=${payload.roomId}`)
      .emit('transactionStateChanged', payload);

    LoggingUtil.log(
      'ChatNotificationService',
      `거래 상태 이벤트 발행: roomId=${payload.roomId}, productId=${payload.productId}, isCompleted=${payload.isCompleted}`,
    );
  }
}
