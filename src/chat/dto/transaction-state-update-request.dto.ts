import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

export class TransactionStateUpdateRequestDto {
  @IsInt()
  @Min(1)
  roomId: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetMemberId?: number;

  @IsInt()
  @Min(1)
  productId: number;

  @IsBoolean()
  isCompleted: boolean;

  @IsDateString()
  createdAt: string;
}
