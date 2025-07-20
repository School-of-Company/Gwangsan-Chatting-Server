import { ChatImageResponse } from "./chat-image-response.dto"

export class ChatSaveMessageDto {
    messageId: number;
    images: ChatImageResponse;
    createdAt: Date;
    senderId: number;
}