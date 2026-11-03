import { createServer, type Server } from 'node:http';
import * as jwt from 'jsonwebtoken';
import { AuthService, authCacheKey } from './auth.service';
import { RedisService } from '../redis/redis.service';

describe('AuthService 인증 캐시', () => {
  const secret = 'test-secret';
  let server: Server;
  let springMemberId: number;
  let springCalls: number;
  let service: AuthService;
  let store: Map<string, string>;
  const env = {
    secret: process.env.JWT_ACCESS_SECRET,
    url: process.env.SPRING_SERVER_URL,
  };

  // iat 만 다르게 해서 같은 sub 의 서로 다른 토큰을 만든다.
  const token = (sub: string, secondsAgo: number) =>
    jwt.sign({ sub, iat: Math.floor(Date.now() / 1000) - secondsAgo }, secret, {
      expiresIn: '1h',
    });

  beforeAll(async () => {
    server = createServer((_req, res) => {
      springCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memberId: springMemberId, nickname: 'n' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    process.env.JWT_ACCESS_SECRET = secret;
    process.env.SPRING_SERVER_URL = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    process.env.JWT_ACCESS_SECRET = env.secret;
    process.env.SPRING_SERVER_URL = env.url;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    springCalls = 0;
    store = new Map();
    const redis = {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      exists: () => Promise.resolve(false),
      del: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
    } as unknown as RedisService;
    service = new AuthService(redis);
    service.onModuleInit();
  });

  it('같은 토큰은 캐시에서 회원 정보를 돌려준다', async () => {
    springMemberId = 1;
    const t = token('01012345678', 60);

    await service.validateToken(`Bearer ${t}`);
    springMemberId = 999;
    const cached = await service.validateToken(`Bearer ${t}`);

    expect(cached.memberId).toBe(1);
    expect(springCalls).toBe(1);
    expect(store.has(authCacheKey(t))).toBe(true);
  });

  it('같은 전화번호로 재가입해 받은 새 토큰은 예전 memberId 를 쓰지 않는다', async () => {
    springMemberId = 1;
    await service.validateToken(`Bearer ${token('01012345678', 60)}`);

    springMemberId = 2; // 탈퇴 후 재가입한 새 회원
    const fresh = await service.validateToken(
      `Bearer ${token('01012345678', 0)}`,
    );

    expect(fresh.memberId).toBe(2);
    expect(springCalls).toBe(2);
  });

  it('캐시 키에 전화번호·토큰 원문을 남기지 않는다', () => {
    const t = token('01012345678', 60);

    expect(authCacheKey(t)).toMatch(/^auth:cache:[0-9a-f]{64}$/);
  });
});
