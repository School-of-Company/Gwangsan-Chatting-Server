import {
  Body,
  Controller,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ChatNotificationService } from './chat-notification.service';
import { TransactionStateUpdateRequestDto } from './dto/transaction-state-update-request.dto';
import { InternalChatGuard } from './internal-chat.guard';
import {
  MessageDeletedRequestDto,
  MessageUpdatedRequestDto,
  SystemMessageRequestDto,
} from './dto/message-event-request.dto';

@Controller('api/internal/chat')
@UseGuards(InternalChatGuard)
export class ChatInternalController {
  constructor(
    private readonly chatNotificationService: ChatNotificationService,
  ) {}

  @Post('transaction-state')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  publishTransactionStateChanged(
    @Body() payload: TransactionStateUpdateRequestDto,
  ): { ok: true } {
    this.chatNotificationService.broadcastTransactionStateChanged(payload);
    return { ok: true };
  }

  @Post('message-updated')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  publishMessageUpdated(@Body() payload: MessageUpdatedRequestDto): {
    ok: true;
  } {
    this.chatNotificationService.broadcastMessageUpdated(payload);
    return { ok: true };
  }

  @Post('message-deleted')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  publishMessageDeleted(@Body() payload: MessageDeletedRequestDto): {
    ok: true;
  } {
    this.chatNotificationService.broadcastMessageDeleted(payload);
    return { ok: true };
  }

  @Post('system-message')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  async publishSystemMessage(
    @Body() payload: SystemMessageRequestDto,
  ): Promise<{ ok: true }> {
    await this.chatNotificationService.broadcastSystemMessage(payload);
    return { ok: true };
  }
}
