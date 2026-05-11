import { UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { AuthService } from '../auth/auth.service';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { MessageType } from './dto/message-type.enum';
import { LoggingUtil } from '../common/logging.util';
import { ChatNotificationService } from './chat-notification.service';

interface ClientData {
  memberId: number;
  nickname: string;
}

@UsePipes(new ValidationPipe({ transform: true }))
@WebSocketGateway({ cors: true, namespace: '/api/chat' })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly authService: AuthService,
    private readonly chatNotificationService: ChatNotificationService,
  ) {}

  afterInit(server: Server) {
    this.server = server;
    this.chatNotificationService.setServer(server);
    server.use((socket, next) => {
      const token = String(socket.handshake.auth.token ?? '');
      if (!token) {
        next(new Error('토큰을 찾을 수 없습니다'));
        return;
      }
      this.authService
        .validateToken(token)
        .then((memberInfo) => {
          (socket.data as ClientData).memberId = memberInfo.memberId;
          (socket.data as ClientData).nickname = memberInfo.nickname;
          next();
        })
        .catch((error: unknown) => {
          next(error instanceof Error ? error : new Error('인증 실패'));
        });
    });
    LoggingUtil.log('ChatGateway', '서버 초기화 완료');
  }

  handleConnection(client: Socket): void {
    LoggingUtil.log(
      'ChatGateway',
      `클라이언트 연결 성공: ${client.id}, memberId=${(client.data as ClientData).memberId}`,
    );
  }

  handleDisconnect(client: Socket) {
    LoggingUtil.log('ChatGateway', `클라이언트 연결 해제: ${client.id}`);
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() roomId: unknown,
    @ConnectedSocket() client: Socket,
  ): void {
    this.assertAuthenticated(client);
    const id = Number(roomId);
    if (!Number.isFinite(id) || id < 1) {
      throw new WsException('유효하지 않은 roomId입니다');
    }
    void client.join(`roomId=${id}`);
    LoggingUtil.log(
      'ChatGateway',
      `클라이언트 방 참여: clientId=${client.id}, roomId=${id}`,
    );
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @MessageBody() roomId: unknown,
    @ConnectedSocket() client: Socket,
  ): void {
    this.assertAuthenticated(client);
    const id = Number(roomId);
    if (!Number.isFinite(id) || id < 1) {
      throw new WsException('유효하지 않은 roomId입니다');
    }
    void client.leave(`roomId=${id}`);
    LoggingUtil.log(
      'ChatGateway',
      `클라이언트 방 퇴장: clientId=${client.id}, roomId=${id}`,
    );
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() message: ChatMessageRequest,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    this.assertAuthenticated(client);

    if (message.messageType === MessageType.TEXT && !message.content) {
      throw new WsException('TEXT 메시지에는 content가 필요합니다');
    }
    if (
      message.messageType === MessageType.IMAGE &&
      (!message.imageIds || message.imageIds.length === 0)
    ) {
      throw new WsException('IMAGE 메시지에는 imageIds가 필요합니다');
    }

    LoggingUtil.log(
      'ChatGateway',
      `메시지 수신: clientId=${client.id}, roomId=${message.roomId}`,
    );
    try {
      const { memberId, nickname } = client.data as ClientData;
      const response = await this.chatService.sendMessage(
        message,
        memberId,
        nickname,
      );

      const roomKey = `roomId=${message.roomId}`;

      client.emit('receiveMessage', { ...response, isMine: true });
      client.to(roomKey).emit('receiveMessage', { ...response, isMine: false });

      this.server.in(roomKey).emit('updateRoomList', {
        roomId: response.roomId,
        lastMessage: response.content,
        lastMessageType: response.messageType,
        lastMessageTime: response.createdAt,
      });
    } catch (error) {
      LoggingUtil.error(
        'ChatGateway',
        `메시지 처리 실패: clientId=${client.id}, roomId=${message.roomId}`,
        error,
      );
      client.emit('error', {
        message: error instanceof Error ? error.message : '메시지 전송 실패',
      });
    }
  }

  private assertAuthenticated(client: Socket): void {
    const memberId = (client.data as ClientData).memberId;
    if (memberId === undefined || memberId === null) {
      LoggingUtil.error('ChatGateway', `미인증 클라이언트: ${client.id}`);
      throw new WsException('인증되지 않은 클라이언트입니다');
    }
  }
}
