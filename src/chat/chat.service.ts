import { Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
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

  /**
   * 이 방에 메시지를 보낼 수 있는지 스프링에 확인한다.
   *
   * 차단 판정은 스프링만 알고 있고, 소켓 브로드캐스트는 스트림 발행 직후 바로
   * 나가므로 여기서 막지 않으면 상대 화면에 메시지가 그대로 뜬다.
   *
   * 검증 자체가 실패하면(타임아웃/5xx) 전송도 거부한다. 스프링이 죽어 있으면
   * 어차피 메시지가 저장되지 않으므로 뚫리는 쪽보다 막는 쪽이 낫다.
   *
   * ponytail: 메시지 1건당 내부 호출 1회. 부담되면 AuthService 처럼 Redis 캐시를
   * 두되, 차단 해제가 즉시 반영되도록 TTL 을 짧게 잡아야 한다.
   */
  private async assertSendable(roomId: number, token: string): Promise<void> {
    const springUrl = process.env.SPRING_SERVER_URL;
    if (!springUrl) {
      throw new Error('SPRING_SERVER_URL이 설정되지 않았습니다.');
    }

    try {
      await this.httpClient.get(
        `${springUrl}/api/chat/room/${roomId}/sendable`,
        { headers: { Authorization: token } },
      );
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;

      LoggingUtil.error(
        'ChatService',
        `메시지 전송 가능 여부 확인 실패: roomId=${roomId}, status=${status ?? 'none'}`,
        error,
      );

      if (status === 403) {
        throw new WsException('차단한 사용자입니다.');
      }
      if (status === 404) {
        throw new WsException('채팅방을 찾을 수 없습니다.');
      }
      throw new WsException('메시지를 전송할 수 없습니다.');
    }
  }

  async sendMessage(
    message: ChatMessageRequest,
    memberId: number,
    nickname: string,
    token: string,
  ): Promise<ChatMessageResponseDto> {
    await this.assertSendable(message.roomId, token);

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
