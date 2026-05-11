import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatNotificationService } from './chat-notification.service';
import { TransactionStateUpdateRequestDto } from './dto/transaction-state-update-request.dto';
import { LoggingUtil } from '../common/logging.util';

@Controller('api/internal/chat')
export class ChatInternalController {
  private readonly internalSecret: string;

  constructor(
    private readonly chatNotificationService: ChatNotificationService,
    private readonly configService: ConfigService,
  ) {
    this.internalSecret = this.configService.getOrThrow<string>(
      'INTERNAL_API_SECRET',
    );
  }

  @Post('transaction-state')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  publishTransactionStateChanged(
    @Headers('x-internal-secret') receivedSecret: string | undefined,
    @Body() payload: TransactionStateUpdateRequestDto,
  ): { ok: true } {
    if (receivedSecret !== this.internalSecret) {
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
