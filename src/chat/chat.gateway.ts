import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';

@WebSocketGateway({ cors: true, namespace: '/api/chat' })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly chatService: ChatService) {}

  afterInit(server: Server) {
    this.server = server;
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth.token;

      this.validateToken(token, client);

      const memberInfo = await this.chatService.validateToken(token);

      client.data.memberId = memberInfo.memberId;
      client.data.nickname = memberInfo.nickname;
    } catch (error) {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    client.disconnect();
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() message: ChatMessageRequest,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const token = client.handshake.auth.token;

    this.validateToken(token, client);

    client.join(`roomId=${message.roomId}`);

    const response = await this.chatService.sendMessage(message, client, token);

    const sockets = await this.server.in(`roomId=${message.roomId}`).fetchSockets();

    for (const socket of sockets) {
      const customizedResponse = new ChatMessageResponseDto(
        response.messageId,
        response.roomId,
        response.content,
        response.messageType,
        response.createdAt,
        response.images,
        response.senderNickname,
        response.senderId,
        response.checked,
        socket.data.memberId === response.senderId
      );

      socket.emit('receiveMessage', customizedResponse);

      socket.emit('updateRoomList', {
        roomId: response.roomId,
        lastMessage: response.content,
        lastMessageType: response.messageType,
        lastMessageTime: response.createdAt,
      });
    }
  }

  private validateToken(token: string, client: Socket): void {
    if (!token) {
      client.disconnect();
      throw new WsException('토큰을 찾을 수 없습니다');
    }
  }
}
