import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsISO8601,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

function MessageId(sign: 'positive' | 'negative' | 'either') {
  return ValidateBy({
    name: 'messageId',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string' || !/^-?[1-9]\d{0,18}$/.test(value))
          return false;
        const id = BigInt(value);
        return (
          id >= -9223372036854775808n &&
          id <= 9223372036854775807n &&
          (sign === 'either' || (sign === 'positive' ? id > 0n : id < 0n))
        );
      },
      defaultMessage: () =>
        'messageId must be a nonzero signed Long with the expected sign',
    },
  });
}

function NormalizeMessageId() {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : value,
  );
}

export class LatestMessageDto {
  @NormalizeMessageId()
  @MessageId('either')
  readonly messageId: string;

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  readonly content: string | null;

  @IsIn(['TEXT', 'IMAGE', 'SYSTEM'])
  readonly messageType: 'TEXT' | 'IMAGE' | 'SYSTEM';

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  readonly createdAt: string;

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  readonly editedAt: string | null;
}

export class MessageDeletedRequestDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  readonly roomId: number;

  @NormalizeMessageId()
  @MessageId('positive')
  readonly messageId: string;

  @IsBoolean()
  @ValidateBy({
    name: 'roomHeadContract',
    validator: {
      validate: (changed: unknown, args) => {
        const payload = args?.object;
        if (!(payload instanceof MessageDeletedRequestDto)) return false;
        if (changed === false) return payload.latestMessage === null;
        return (
          !(payload instanceof MessageUpdatedRequestDto) ||
          payload.latestMessage !== null
        );
      },
    },
  })
  readonly roomListChanged: boolean;

  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => LatestMessageDto)
  readonly latestMessage: LatestMessageDto | null;
}

export class MessageUpdatedRequestDto extends MessageDeletedRequestDto {
  @IsString()
  @Matches(/\S/)
  readonly content: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  readonly editedAt: string;
}

export class SystemMessageRequestDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  readonly roomId: number;

  @NormalizeMessageId()
  @MessageId('negative')
  readonly messageId: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  readonly senderId: number;

  @IsString()
  @Matches(/\S/)
  readonly content: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  readonly createdAt: string;
}
