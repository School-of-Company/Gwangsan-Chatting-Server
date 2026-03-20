import { ChatImageResponse } from './chat-image-response.dto';

export class ChatSaveMessageDto {
  constructor(
    public readonly messageId: number,
    public readonly images: ChatImageResponse[],
    public readonly createdAt: Date,
    public readonly senderId: number,
  ) {}
}
