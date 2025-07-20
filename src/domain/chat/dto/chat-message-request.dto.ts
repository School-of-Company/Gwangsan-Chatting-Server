import { MessageType } from "./constant/message-type.enum";

export class ChatMessageRequest {
  constructor(
    public readonly roomId: number,
    public readonly content: string | null,
    public readonly imageIds: number[],
    public readonly messageType: MessageType,
  ) {}
}
