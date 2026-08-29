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

  /**
   * @deprecated 거래 상태는 방 단위 상태이므로 수신 대상을 좁히지 않는다.
   * Spring 이 더 이상 보내지 않으며, 하위 호환을 위해 필드만 남겨 둔다.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  targetMemberId?: number;

  @IsInt()
  @Min(1)
  productId: number;

  @IsBoolean()
  isCompleted: boolean;

  @IsOptional()
  @IsBoolean()
  isReserved?: boolean;

  /**
   * 거래 요청(TradeComplete) 생성 시각. 상품 생성 시각이 아니다.
   * 활성 거래 요청이 없으면(요청 전 / 롤백 후) null 이 온다.
   */
  @IsOptional()
  @IsDateString()
  createdAt?: string | null;

  /**
   * 거래 완료를 먼저 요청한 쪽이 판매자인지. 대기 중인 요청이 없으면 null.
   *
   * isCompletable 은 보는 사람의 isSeller 에 따라 달라지는 값이라 방 전체로
   * 발행할 수 없다. 대신 모든 참여자에게 동일한 사실인 이 필드를 보내고,
   * 클라이언트가 자신의 isSeller 와 조합해 계산한다.
   *
   *   isCompletable = !isCompleted &&
   *     (requestedBySeller == null || requestedBySeller !== isSeller)
   */
  @IsOptional()
  @IsBoolean()
  requestedBySeller?: boolean | null;
}
