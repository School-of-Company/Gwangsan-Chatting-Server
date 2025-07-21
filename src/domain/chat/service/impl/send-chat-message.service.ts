import { Injectable } from "@nestjs/common";
import { ISendChatMessageService } from "../isend-chat-message.interface";
import { Socket } from "socket.io";
import { ChatMessageRequest } from "src/domain/chat/dto/chat-message-request.dto";
import { ChatMessageResponseDto } from "src/domain/chat/dto/chat-message-response.dto";
import { ChatImageResponse } from "src/domain/chat/dto/chat-image-response.dto";
import axios from "axios";
import { ChatSaveMessageDto } from "src/domain/chat/dto/chat-save-message.dto";

@Injectable()
export class SendChatMessageService implements ISendChatMessageService {
    private readonly CONTEXT = SendChatMessageService.name;

    async execute(message: ChatMessageRequest, client: Socket, token: string): Promise<ChatMessageResponseDto> {
        try {
            const { data: response } = await axios.post<ChatSaveMessageDto>(
                `${process.env.SPRING_SERVER_URL}/api/chat/message`,
                message,
                {
                    headers: { Authorization: `${token}` }
                }
            );

            let imageResponses: ChatImageResponse[] | null = null;

            if (response.images && Array.isArray(response.images) && response.images.length > 0) {
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
        } catch (error) {
            throw error;
        }
    }
}
