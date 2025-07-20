import { Module } from '@nestjs/common';

import { ChatModule } from './chat/chat.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ChatModule
  ]
})
export class AppModule {}
