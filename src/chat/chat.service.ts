import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { MemberInfo } from './dto/chat-member-info.dto';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';
import { ChatImageResponse } from './dto/chat-image-response.dto';
import { ChatSaveMessageDto } from './dto/chat-save-message.dto';
import { LoggingUtil } from '../common/logging.util';

@Injectable()
export class ChatService {

    async validateToken(token: string): Promise<MemberInfo> {
        try {
            const response = await axios.get(
                `${process.env.SPRING_SERVER_URL}/api/auth`,
                {
                    headers: { Authorization: `${token}` },
                },
            );

            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    LoggingUtil.error('ChatService', '토큰 인증 실패 (401)', error);
                    throw new UnauthorizedException('인증에 실패했습니다.');
                }
                LoggingUtil.error('ChatService', 'Axios 오류 발생', error);
                throw new InternalServerErrorException('서버 내부 오류가 발생했습니다.');
            }
            throw error;
        }
    }

    async sendMessage(message: ChatMessageRequest, memberId: number, nickname: string, token: string): Promise<ChatMessageResponseDto> {
        try {
            const { data: response } = await axios.post<ChatSaveMessageDto>(
                `${process.env.SPRING_SERVER_URL}/api/chat`,
                message,
                {
                    headers: { Authorization: `${token}` }
                }
            );

            let imageResponses: ChatImageResponse[] | null = null;

            if (response.images?.length) {
                imageResponses = response.images.map(img => new ChatImageResponse(img.imageId, img.imageUrl));
            }

            LoggingUtil.log('ChatService', `메시지 전송 성공: roomId=${message.roomId}, memberId=${memberId}`);

            return new ChatMessageResponseDto(
                response.messageId,
                message.roomId,
                message.content,
                message.messageType,
                response.createdAt,
                imageResponses,
                nickname,
                memberId,
                false,
                false
            );
        } catch (error) {
            LoggingUtil.error('ChatService', `메시지 전송 실패: roomId=${message.roomId}, memberId=${memberId}`, error);
            throw error;
        }
    }
}
