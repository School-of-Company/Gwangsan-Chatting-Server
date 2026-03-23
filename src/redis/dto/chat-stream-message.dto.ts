import { MessageType } from '../../chat/dto/message-type.enum';

export const ChatStreamField = {
  MESSAGE_ID: 'messageId',
  ROOM_ID: 'roomId',
  SENDER_ID: 'senderId',
  CONTENT: 'content',
  MESSAGE_TYPE: 'messageType',
  IMAGE_IDS: 'imageIds',
  CREATED_AT: 'createdAt',
} as const;

export class ChatStreamMessageDto {
  messageId: string;
  roomId: string;
  senderId: string;
  content: string;
  messageType: string;
  imageIds: string;
  createdAt: string;

  static from(
    messageId: string,
    roomId: number,
    senderId: number,
    content: string | null,
    messageType: MessageType,
    imageIds: number[],
    createdAt: Date,
  ): ChatStreamMessageDto {
    const dto = new ChatStreamMessageDto();
    dto.messageId = messageId;
    dto.roomId = String(roomId);
    dto.senderId = String(senderId);
    dto.content = content ?? '';
    dto.messageType = messageType;
    dto.imageIds = JSON.stringify(imageIds ?? []);
    dto.createdAt = String(createdAt.getTime());
    return dto;
  }

  toFields(): Record<string, string> {
    return {
      [ChatStreamField.MESSAGE_ID]: this.messageId,
      [ChatStreamField.ROOM_ID]: this.roomId,
      [ChatStreamField.SENDER_ID]: this.senderId,
      [ChatStreamField.CONTENT]: this.content,
      [ChatStreamField.MESSAGE_TYPE]: this.messageType,
      [ChatStreamField.IMAGE_IDS]: this.imageIds,
      [ChatStreamField.CREATED_AT]: this.createdAt,
    };
  }
}
