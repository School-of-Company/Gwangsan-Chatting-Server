import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { ChatModule } from './chat/chat.module';
import { TelemetryModule } from './telemetry/telemetry.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelemetryModule,
    ChatModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
