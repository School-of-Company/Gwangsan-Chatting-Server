import { Injectable } from "@nestjs/common";
import { ISendChatMessageService } from "../isend-chat-message.interface";
import { Socket } from "socket.io";
import { ChatMessageRequest } from "src/chat/dto/chat-message-request.dto";
import { ChatmessageResponseDto } from "src/chat/dto/chat-message-response.dto";
import { ChatImageResponse } from "src/chat/dto/chat-image-response.dto";
import axios from "axios";
import { ChatSaveMessageDto } from "src/chat/dto/chat-save-message.dto";

@Injectable()
export class SendChatMessageService implements ISendChatMessageService {

    async execute(message: ChatMessageRequest, client: Socket, token: string): Promise<ChatmessageResponseDto> {
        console.log(`[SendChatMessageService] Sending POST to Spring /api/chat with token: ${token} and message:`, message);

        try {
            const { data: response } = await axios.post<ChatSaveMessageDto>(
                `${process.env.SPRING_SERVER_URL}/api/chat`,
                message,
                {
                    headers: { Authorization: `${token}` }
                }
            );

            console.log('[SendChatMessageService] Received response from Spring:', response);

            let imageResponses: ChatImageResponse[] | null = null;

            if (response.images && Array.isArray(response.images) && response.images.length > 0) {
                imageResponses = response.images.map(img => new ChatImageResponse(img.imageId, img.imageUrl));
            }

            return new ChatmessageResponseDto(
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
            console.error('[SendChatMessageService] Error calling Spring /api/chat:', error);
            throw error;
        }
    }
}
