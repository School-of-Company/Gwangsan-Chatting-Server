import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import * as path from 'path';
import {
  GenericContainer,
  StartedTestContainer,
  StartedNetwork,
  Wait,
  Network,
} from 'testcontainers';
import { AppModule } from '../src/app.module';

const JWT_SECRET = 'test-secret';
const SPRING_JAR =
  process.env.SPRING_JAR_PATH ??
  path.resolve(
    __dirname,
    '../../Gwangsan-Server-clean/build/libs/gwangsan-0.0.1-SNAPSHOT.jar',
  );

describe('Cross-Service E2E (NestJS → Redis Stream → Spring)', () => {
  let nestApp: INestApplication;
  let redis: Redis;
  let network: StartedNetwork;
  let redisContainer: StartedTestContainer;
  let mariadbContainer: StartedTestContainer;
  let springContainer: StartedTestContainer;

  beforeAll(async () => {
    jest.setTimeout(180000);

    network = await new Network().start();

    redisContainer = await new GenericContainer('redis:7-alpine')
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(6379)
      .start();

    mariadbContainer = await new GenericContainer('mariadb:11')
      .withNetwork(network)
      .withNetworkAliases('mariadb')
      .withEnvironment({
        MYSQL_ROOT_PASSWORD: 'password',
        MYSQL_DATABASE: 'gwangsan_db',
      })
      .withExposedPorts(3306)
      .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 1))
      .start();

    springContainer = await new GenericContainer(
      'eclipse-temurin:21-jre-alpine',
    )
      .withNetwork(network)
      .withBindMounts([
        { source: SPRING_JAR, target: '/app/app.jar', mode: 'ro' },
      ])
      .withCommand(['java', '-jar', '/app/app.jar'])
      .withEnvironment({
        SPRING_PROFILES_ACTIVE: 'test',
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        JWT_ACCESS_SECRET: JWT_SECRET,
        RDB_HOST: 'mariadb',
        RDB_PORT: '3306',
        RDB_SCHEMA: 'gwangsan_db',
        DB_USER: 'root',
        DB_PASSWORD: 'password',
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forLogMessage(/Started GwangsanApplication/, 1))
      .start();

    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);

    process.env.JWT_ACCESS_SECRET = JWT_SECRET;
    process.env.SPRING_SERVER_URL = `http://localhost:${springContainer.getMappedPort(8080)}`;
    process.env.REDIS_HOST = redisHost;
    process.env.REDIS_PORT = String(redisPort);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    nestApp = moduleFixture.createNestApplication();
    await nestApp.listen(0);

    redis = new Redis({ host: redisHost, port: redisPort });
  }, 120000);

  afterAll(async () => {
    await redis?.quit();
    await nestApp?.close();
    await springContainer?.stop();
    await mariadbContainer?.stop();
    await redisContainer?.stop();
    await network?.stop();
  });

  function makeToken(sub: string): string {
    return jwt.sign({ sub }, JWT_SECRET, { expiresIn: '1h' });
  }

  async function seedAuthCache(
    sub: string,
    memberId: number,
    nickname: string,
  ): Promise<void> {
    await redis.set(
      `auth:cache:${sub}`,
      JSON.stringify({ memberId, nickname }),
      'EX',
      3600,
    );
  }

  function getPort(): number {
    const server = nestApp.getHttpServer() as import('net').Server;
    const addr = server.address();
    return typeof addr === 'string' || addr === null ? 0 : addr.port;
  }

  function connect(port: number, token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`http://localhost:${port}/api/chat`, {
        auth: { token },
        transports: ['websocket'],
      });
      const timer = setTimeout(
        () => reject(new Error('connect timeout')),
        10000,
      );
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async function waitForStreamConsumed(
    streamKey: string,
    group: string,
    timeoutMs = 15000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pending = await redis.xpending(streamKey, group, '-', '+', 10);
        if (pending.length === 0) return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('NOGROUP')) throw err;
        // 그룹이 아직 생성되지 않음 - Spring이 초기화 중
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `Stream ${streamKey} was not consumed within ${timeoutMs}ms`,
    );
  }

  it('NestJS sendMessage → Redis Stream → Spring 소비 확인', async () => {
    const roomId = 1;
    const memberId = 1;
    const phoneNumber = 'cross-test-user';
    const streamKey = `chat:room:${roomId}:messages`;
    const group = 'chat-message-persistors';

    await seedAuthCache(phoneNumber, memberId, 'CrossTester');
    const token = makeToken(phoneNumber);

    const socket = await connect(getPort(), token);
    await new Promise((r) => setTimeout(r, 300));

    socket.emit('joinRoom', roomId);
    await new Promise((r) => setTimeout(r, 200));

    const receivePromise = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('receiveMessage timeout')),
          5000,
        );
        socket.on('receiveMessage', (data: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(data);
        });
      },
    );

    socket.emit('sendMessage', {
      roomId,
      content: '크로스 서비스 테스트',
      imageIds: [],
      messageType: 'TEXT',
    });

    const received = await receivePromise;
    expect(received.content).toBe('크로스 서비스 테스트');
    expect(received.isMine).toBe(true);

    const entries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', 1);
    expect(entries.length).toBe(1);

    await waitForStreamConsumed(streamKey, group, 10000);

    socket.disconnect();
    await redis.del(streamKey);
    await redis.del(`auth:cache:${phoneNumber}`);
  });
});
