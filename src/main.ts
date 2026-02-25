import { NestFactory } from '@nestjs/core';
import { AppModule } from './domain/app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
