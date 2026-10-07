import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ChatInternalController } from './chat-internal.controller';
import { ChatNotificationService } from './chat-notification.service';
import { InternalChatGuard } from './internal-chat.guard';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [ChatInternalController],
  providers: [
    ChatGateway,
    ChatService,
    ChatNotificationService,
    InternalChatGuard,
  ],
})
export class ChatModule {}
