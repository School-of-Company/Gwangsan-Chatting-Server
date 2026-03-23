import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { MessageType } from './message-type.enum';

export class ChatMessageRequest {
  @IsNumber()
  @Min(1)
  roomId: number;

  @IsString()
  @IsOptional()
  content: string | null;

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  imageIds: number[] = [];

  @IsEnum(MessageType)
  messageType: MessageType;
}
