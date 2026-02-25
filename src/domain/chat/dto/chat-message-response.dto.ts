import { ChatImageResponse } from "./chat-image-response.dto";
import { MessageType } from "./constant/message-type.enum";

export class ChatMessageResponseDto {
    constructor(
        public readonly messageId: number,
        public readonly roomId: number,
        public readonly content: string | null,
        public readonly messageType: MessageType,
        public readonly createdAt: Date,
        public readonly images: ChatImageResponse[] | null,
        public readonly senderNickname: string,
        public readonly senderId: number,
        public readonly checked: boolean,
        public isMine: boolean
    ) {}
}