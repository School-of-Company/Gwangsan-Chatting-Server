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
import { timingSafeEqual } from 'crypto';
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
    if (!this.isValidInternalSecret(receivedSecret)) {
      LoggingUtil.error(
        'ChatInternalController',
        `내부 API 인증 실패: roomId=${payload.roomId}, productId=${payload.productId}`,
      );
      throw new UnauthorizedException('유효하지 않은 내부 인증 정보입니다.');
    }

    this.chatNotificationService.broadcastTransactionStateChanged(payload);
    return { ok: true };
  }

  private isValidInternalSecret(receivedSecret: string | undefined): boolean {
    if (!receivedSecret) {
      return false;
    }

    const receivedBuffer = Buffer.from(receivedSecret);
    const expectedBuffer = Buffer.from(this.internalSecret);

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(receivedBuffer, expectedBuffer);
  }
}
