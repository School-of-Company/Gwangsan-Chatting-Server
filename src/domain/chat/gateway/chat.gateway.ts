import { Inject } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatMessageRequest } from '../dto/chat-message-request.dto';
import { ChatmessageResponseDto } from '../dto/chat-message-response.dto';
import { memberInfo } from '../dto/chat-member-info.dto';
import { IAUTH_TOKEN_SERVICE, ISEND_CHAT_MESSAGE_SERVICE } from 'src/global/core/di.tokens';
import { ISendChatMessageService } from '../service/isend-chat-message.interface';
import { IAuthTokenService } from '../service/iauth-token.service';

@WebSocketGateway({cors: true})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(
    @Inject(ISEND_CHAT_MESSAGE_SERVICE) private readonly sendChatMessageService: ISendChatMessageService,
    @Inject(IAUTH_TOKEN_SERVICE) private readonly authTokenService: IAuthTokenService,
  ) {}

  afterInit(server: Server) {
    this.server = server;
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth.token;

      this.validateToken(token, client);

      const memberInfo: memberInfo = await this.authTokenService.execute(token);

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

    const response = await this.sendChatMessageService.execute(message, client, token);

    const sockets = await this.server.in(`roomId=${message.roomId}`).fetchSockets();

    for (const socket of sockets) {
      const customizedResponse = new ChatmessageResponseDto(
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
    }
  }

  private async validateToken(token: string, client: Socket): Promise<void> {
    if (!token) {
      client.disconnect();
      throw new WsException('토큰을 찾을 수 없습니다');
    }
  }
}