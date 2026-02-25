import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { Socket } from 'socket.io';
import axios from 'axios';
import { MemberInfo } from './dto/chat-member-info.dto';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { ChatMessageResponseDto } from './dto/chat-message-response.dto';
import { ChatImageResponse } from './dto/chat-image-response.dto';
import { ChatSaveMessageDto } from './dto/chat-save-message.dto';

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
                    throw new UnauthorizedException('인증에 실패했습니다.');
                }
                throw new InternalServerErrorException('서버 내부 오류가 발생했습니다.');
            }
            throw error;
        }
    }

    async sendMessage(message: ChatMessageRequest, client: Socket, token: string): Promise<ChatMessageResponseDto> {
        const { data: response } = await axios.post<ChatSaveMessageDto>(
            `${process.env.SPRING_SERVER_URL}/api/chat`,
            message,
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        );

        let imageResponses: ChatImageResponse[] | null = null;

        if (response.images?.length) {
            imageResponses = response.images.map(img => new ChatImageResponse(img.imageId, img.imageUrl));
        }

        return new ChatMessageResponseDto(
            response.messageId,
            message.roomId,
            message.content,
            message.messageType,
            response.createdAt,
            imageResponses,
            client.data.nickname,
            client.data.memberId,
            false,
            true
        );
    }
}
