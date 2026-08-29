import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';
import { LoggingUtil } from '../common/logging.util';
import { RedisStreamPublisher } from '../redis/redis-stream.publisher';
import { ChatStreamMessageDto } from '../redis/dto/chat-stream-message.dto';
import { generateSnowflakeId } from '../common/snowflake.util';

const SPRING_REQUEST_TIMEOUT_MS = 5000;

interface ChatRoomSummary {
  roomId: number;
}

@Injectable()
export class ChatService {
  private readonly httpClient: AxiosInstance = axios.create({
    timeout: SPRING_REQUEST_TIMEOUT_MS,
    httpAgent: new HttpAgent({ keepAlive: true }),
    httpsAgent: new HttpsAgent({ keepAlive: true }),
  });

  constructor(private readonly redisStreamPublisher: RedisStreamPublisher) {}

  /**
   * 접속한 회원이 참여 중인 채팅방 id 목록.
   *
   * 소켓 연결 시점에 모든 방을 자동 join 하기 위해 사용한다. 방 목록 조회 API를
   * 그대로 재사용하므로 별도 내부 API가 필요 없다.
   *
   * ponytail: 연결 1회당 방 목록 조회 1회. 방이 많아져 부담되면 roomId만 돌려주는
   * 경량 내부 엔드포인트로 교체.
   */
  async fetchJoinedRoomIds(token: string): Promise<number[]> {
    const springUrl = process.env.SPRING_SERVER_URL;
    if (!springUrl) {
      throw new Error('SPRING_SERVER_URL이 설정되지 않았습니다.');
    }

    const response = await this.httpClient.get(`${springUrl}/api/chat/rooms`, {
      headers: { Authorization: token },
    });

    const rooms = response.data as ChatRoomSummary[];
    if (!Array.isArray(rooms)) {
      return [];
    }

    return rooms
      .map((room) => Number(room?.roomId))
      .filter((roomId) => Number.isFinite(roomId) && roomId >= 1);
  }

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
