import { Injectable } from '@nestjs/common';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';
import { LoggingUtil } from '../common/logging.util';
import { RedisStreamPublisher } from '../redis/redis-stream.publisher';
import { ChatStreamMessageDto } from '../redis/dto/chat-stream-message.dto';
import { generateSnowflakeId } from '../common/snowflake.util';

@Injectable()
export class ChatService {
  constructor(private readonly redisStreamPublisher: RedisStreamPublisher) {}

  async sendMessage(
    message: ChatMessageRequest,
    memberId: number,
    nickname: string,
  ): Promise<ChatMessageResponseDto> {
    const streamKey = `chat:room:${message.roomId}:messages`;
    const messageId = generateSnowflakeId();
    const createdAt = new Date();

    try {
      const payload = ChatStreamMessageDto.from(
        messageId,
        message.roomId,
        memberId,
        message.content,
        message.messageType,
        message.imageIds,
        createdAt,
      );
      await this.redisStreamPublisher.publish(streamKey, payload.toFields());

      LoggingUtil.log(
        'ChatService',
        `메시지 스트림 발행 성공: roomId=${message.roomId}, memberId=${memberId}`,
      );

      return new ChatMessageResponseDto({
        messageId,
        roomId: message.roomId,
        content: message.content,
        messageType: message.messageType,
        createdAt,
        images: null,
        senderNickname: nickname,
        senderId: memberId,
        checked: false,
      });
    } catch (error) {
      LoggingUtil.error(
        'ChatService',
        `메시지 스트림 발행 실패: roomId=${message.roomId}, memberId=${memberId}`,
        error,
      );
      throw error;
    }
  }
}
