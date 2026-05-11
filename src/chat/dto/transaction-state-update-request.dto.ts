import { IsBoolean, IsDateString, IsInt, Min } from 'class-validator';

export class TransactionStateUpdateRequestDto {
  @IsInt()
  @Min(1)
  roomId: number;

  @IsInt()
  @Min(1)
  productId: number;

  @IsBoolean()
  isCompleted: boolean;

  @IsDateString()
  createdAt: string;
}
