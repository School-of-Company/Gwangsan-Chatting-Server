import { Module } from '@nestjs/common';
import { ChatGateway } from './gateway/chat.gateway';
import { IAUTH_TOKEN_SERVICE, ISEND_CHAT_MESSAGE_SERVICE } from 'src/core/di.tokens';
import { AuthTokenService } from './service/impl/auth-token.service';
import { SendChatMessageService } from './service/impl/send-chat-message.service';

@Module({
  providers: [
    ChatGateway,
    {
      provide: ISEND_CHAT_MESSAGE_SERVICE,
      useClass: SendChatMessageService,
    },
    {
      provide: IAUTH_TOKEN_SERVICE,
      useClass: AuthTokenService,
    },
    ChatGateway
  ],
})
export class ChatModule {}
