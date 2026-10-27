import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// 실제 시크릿 없이 앱을 띄우기 위한 합성 값. 헬스 체크는 Redis 를 쓰지 않으므로 클라이언트도 스텁으로 둔다.
// SPRING_SERVER_URL 은 기동 검증용일 뿐 헬스 체크에서 호출되지 않는다(닫힌 포트).
const TEST_ENV = {
  INTERNAL_API_SECRET: 'app-e2e-synthetic-internal-secret',
  JWT_ACCESS_SECRET: 'app-e2e-synthetic-jwt-secret',
  SPRING_SERVER_URL: 'http://127.0.0.1:1',
  METRICS_PORT: '0',
};

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('REDIS_CLIENT')
      .useValue({ quit: jest.fn().mockResolvedValue('OK') })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('/api/health/check (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health/check')
      .expect(200)
      .expect('ok');
  });
});
