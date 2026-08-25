import { ChatImageResponse } from './chat-image-response.dto';
import { MessageType } from './message-type.enum';

export interface ChatMessageResponseParams {
  messageId: string;
  roomId: number;
  content: string | null;
  messageType: MessageType;
  createdAt: Date;
  images: ChatImageResponse[] | null;
  senderNickname: string;
  senderId: number;
  checked: boolean;
}

export class ChatMessageResponseDto {
  public readonly messageId: string;
  public readonly roomId: number;
  public readonly content: string | null;
  public readonly messageType: MessageType;
  public readonly createdAt: Date;
  public readonly images: ChatImageResponse[] | null;
  public readonly senderNickname: string;
  public readonly senderId: number;
  public readonly checked: boolean;

  constructor(params: ChatMessageResponseParams) {
    this.messageId = params.messageId;
    this.roomId = params.roomId;
    this.content = params.content;
    this.messageType = params.messageType;
    this.createdAt = params.createdAt;
    this.images = params.images;
    this.senderNickname = params.senderNickname;
    this.senderId = params.senderId;
    this.checked = params.checked;
  }
}
