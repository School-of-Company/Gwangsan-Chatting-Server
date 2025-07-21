import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ChatModule
  ],
  controllers: [AppController]
})
export class AppModule {}
