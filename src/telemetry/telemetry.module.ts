import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { SocketEventInterceptor } from './socket-event';

@Global()
@Module({
  providers: [MetricsService, SocketEventInterceptor],
  exports: [MetricsService, SocketEventInterceptor],
})
export class TelemetryModule {}
