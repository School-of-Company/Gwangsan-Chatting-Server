import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';
import { LoggingUtil } from '../common/logging.util';

@WebSocketGateway({ cors: true, namespace: '/api/chat' })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly chatService: ChatService) {}

  afterInit(server: Server) {
    this.server = server;
    LoggingUtil.log('ChatGateway', '서버 초기화 완료');
  }

  async handleConnection(client: Socket): Promise<void> {
    LoggingUtil.log('ChatGateway', `클라이언트 연결 시도: ${client.id}`);
    try {
      const token = client.handshake.auth.token;

      this.validateToken(token, client);

      const memberInfo = await this.chatService.validateToken(token);

      client.data.memberId = memberInfo.memberId;
      client.data.nickname = memberInfo.nickname;
      LoggingUtil.log('ChatGateway', `클라이언트 연결 성공: ${client.id}, memberId=${memberInfo.memberId}, nickname=${memberInfo.nickname}`);
    } catch (error) {
      LoggingUtil.error('ChatGateway', `클라이언트 연결 실패: ${client.id}`, error);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    LoggingUtil.log('ChatGateway', `클라이언트 연결 해제: ${client.id}`);
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() roomId: number,
    @ConnectedSocket() client: Socket,
  ): void {
    client.join(`roomId=${roomId}`);
    LoggingUtil.log('ChatGateway', `클라이언트 방 참여: clientId=${client.id}, roomId=${roomId}`);
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @MessageBody() roomId: number,
    @ConnectedSocket() client: Socket,
  ): void {
    client.leave(`roomId=${roomId}`);
    LoggingUtil.log('ChatGateway', `클라이언트 방 퇴장: clientId=${client.id}, roomId=${roomId}`);
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() message: ChatMessageRequest,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    if (!message.roomId) {
      LoggingUtil.error('ChatGateway', `roomId 없음: clientId=${client.id}`);
      throw new WsException('roomId가 필요합니다');
    }

    LoggingUtil.log('ChatGateway', `메시지 수신: clientId=${client.id}, roomId=${message.roomId}`);
    try {
      const token = client.handshake.auth.token;

      this.validateToken(token, client);

      const response = await this.chatService.sendMessage(message, client.data.memberId, client.data.nickname, token);

      const roomKey = `roomId=${message.roomId}`;
      const updateRoomPayload = {
        roomId: response.roomId,
        lastMessage: response.content,
        lastMessageType: response.messageType,
        lastMessageTime: response.createdAt,
      };

      client.emit('receiveMessage', new ChatMessageResponseDto(
        response.messageId,
        response.roomId,
        response.content,
        response.messageType,
        response.createdAt,
        response.images,
        response.senderNickname,
        response.senderId,
        response.checked,
        true
      ));

      client.to(roomKey).emit('receiveMessage', new ChatMessageResponseDto(
        response.messageId,
        response.roomId,
        response.content,
        response.messageType,
        response.createdAt,
        response.images,
        response.senderNickname,
        response.senderId,
        response.checked,
        false
      ));

      this.server.in(roomKey).emit('updateRoomList', updateRoomPayload);
    } catch (error) {
      LoggingUtil.error('ChatGateway', `메시지 처리 실패: clientId=${client.id}, roomId=${message.roomId}`, error);
      throw error;
    }
  }

  private validateToken(token: string, client: Socket): void {
    if (!token) {
      LoggingUtil.error('ChatGateway', `토큰 없음: clientId=${client.id}`);
      throw new WsException('토큰을 찾을 수 없습니다');
    }
  }
}
