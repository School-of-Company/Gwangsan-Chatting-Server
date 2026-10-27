// 반드시 첫 import: Nest/http/ioredis 가 로드되기 전에 OTel 계측을 건다.
import { shutdownTelemetry } from './instrumentation';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonNestLogger } from './common/logging.util';

const SHUTDOWN_TIMEOUT_MS = 5000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new JsonNestLogger(),
  });

  app.enableCors({
    origin: [
      'http://localhost:8080',
      'http://localhost:8081',
      'http://localhost:19006',
      'http://10.177.176.102:8081',
      'https://api.gwangsan.io.kr',
      'https://gwangsan.io.kr',
      /^https?:\/\/.*\.exp\.direct$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });

  // SIGTERM 시 소켓/Redis/메트릭 리스너를 닫고 남은 span 을 내보낸 뒤 원래 신호로 종료한다.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void Promise.race([
        app.close(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ])
        .then(() => shutdownTelemetry())
        .finally(() => process.kill(process.pid, signal));
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
