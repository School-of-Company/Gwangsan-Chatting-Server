import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
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
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(Number.MAX_SAFE_INTEGER, { each: true })
  imageIds: number[] = [];

  @IsEnum(MessageType)
  messageType: MessageType;
}
