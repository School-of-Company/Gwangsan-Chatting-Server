import {
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ChatNotificationService } from './chat-notification.service';
import { TransactionStateUpdateRequestDto } from './dto/transaction-state-update-request.dto';
import { LoggingUtil } from '../common/logging.util';

@Controller('api/internal/chat')
export class ChatInternalController {
  private readonly internalSecret: string;

  constructor(
    private readonly chatNotificationService: ChatNotificationService,
  ) {
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (!internalSecret) {
      throw new InternalServerErrorException(
        'INTERNAL_API_SECRET이 설정되지 않았습니다.',
      );
    }
    this.internalSecret = internalSecret;
  }

  @Post('transaction-state')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  publishTransactionStateChanged(
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Body() payload: TransactionStateUpdateRequestDto,
  ): { ok: true } {
    if (internalSecret !== this.internalSecret) {
      LoggingUtil.error(
        'ChatInternalController',
        `내부 API 인증 실패: roomId=${payload.roomId}, productId=${payload.productId}`,
      );
      throw new UnauthorizedException('유효하지 않은 내부 인증 정보입니다.');
    }

    this.chatNotificationService.broadcastTransactionStateChanged(payload);
    return { ok: true };
  }
}
