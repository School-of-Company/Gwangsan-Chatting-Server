import { Socket } from "socket.io";
import { ChatMessageRequest } from "../dto/chat-message-request.dto";
import { ChatMessageResponseDto } from "../dto/chat-message-response.dto";

export interface ISendChatMessageService {
    execute(message: ChatMessageRequest, client: Socket, token: string, ): Promise<ChatMessageResponseDto>
}