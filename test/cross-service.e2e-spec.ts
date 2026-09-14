import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import * as path from 'path';
import * as request from 'supertest';
import {
  GenericContainer,
  StartedTestContainer,
  StartedNetwork,
  Wait,
  Network,
} from 'testcontainers';
import { AppModule } from '../src/app.module';

const JWT_SECRET = 'cross-service-test-secret-at-least-32-bytes';
const SPRING_JAR =
  process.env.SPRING_JAR_PATH ??
  path.resolve(
    __dirname,
    '../../Gwangsan-Server-clean/build/libs/gwangsan-0.0.1-SNAPSHOT.jar',
  );

describe('Cross-Service E2E (NestJS → Redis Stream → Spring)', () => {
  let nestApp: INestApplication;
  let springUrl: string;
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

    const seeded = await mariadbContainer.exec([
      'mariadb',
      '-uroot',
      '-ppassword',
      'gwangsan_db',
      '-e',
      `
        INSERT INTO tbl_member (member_id, name, nickname, password, phone_number, role, member_status, joined_at)
        VALUES (1, 'CrossTester', 'CrossTester', 'unused', 'cross-test-user', 'ROLE_USER', 'ACTIVE', NOW()),
               (2, 'Receiver', 'Receiver', 'unused', 'cross-test-receiver', 'ROLE_USER', 'ACTIVE', NOW());
        INSERT INTO tbl_product (product_id, title, description, gwangsan, member_id, type, mode, status, created_at, updated_at)
        VALUES (1, 'Fixture', 'Fixture', 0, 2, 'OBJECT', 'GIVER', 'ONGOING', NOW(), NOW());
        INSERT INTO tbl_chat_room (room_id, created_at, is_active, buyer_id, seller_id, product_id)
        VALUES (1, NOW(), TRUE, 1, 2, 1);
        INSERT INTO tbl_image (image_id, image_url, created_at)
        VALUES (11, 'https://images.example/cross-11.jpg', NOW()), (12, 'https://images.example/cross-12.jpg', NOW());
      `,
    ]);
    if (seeded.exitCode !== 0) throw new Error(seeded.output);

    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);

    process.env.JWT_ACCESS_SECRET = JWT_SECRET;
    process.env.INTERNAL_API_SECRET = 'cross-service-internal-test-secret';
    springUrl = `http://${springContainer.getHost()}:${springContainer.getMappedPort(8080)}`;
    process.env.SPRING_SERVER_URL = springUrl;
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

  it.each([
    {
      messageType: 'TEXT',
      content: '크로스 서비스 테스트',
      imageIds: [],
      images: [],
    },
    {
      messageType: 'IMAGE',
      content: null,
      imageIds: [11, 12],
      images: [
        { imageId: 11, imageUrl: 'https://images.example/cross-11.jpg' },
        { imageId: 12, imageUrl: 'https://images.example/cross-12.jpg' },
      ],
    },
  ])(
    '$messageType echo 후 Spring REST에서 비동기 저장을 확인한다',
    async ({ messageType, content, imageIds, images }) => {
      const roomId = 1;
      const phoneNumber = 'cross-test-user';
      await seedAuthCache(phoneNumber, 1, 'CrossTester');
      const token = makeToken(phoneNumber);
      const socket = await connect(getPort(), `Bearer ${token}`);
      try {
        const received = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('receiveMessage timeout')),
              7000,
            );
            socket.once('error', (error: unknown) => {
              clearTimeout(timer);
              reject(new Error(JSON.stringify(error)));
            });
            socket.once('receiveMessage', (value: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(value);
            });
            socket.emit('sendMessage', {
              roomId,
              content,
              imageIds,
              messageType,
            });
          },
        );
        expect(received).toMatchObject({
          roomId,
          messageType,
          isMine: true,
          images: messageType === 'IMAGE' ? images : null,
        });

        const messageId = String(received.messageId);
        if (!/^\d+$/.test(messageId)) throw new Error('Invalid message ID');
        const expectedCommit = `1:${imageIds.join(',')}`;
        const deadline = Date.now() + 15000;
        let committed = '';
        while (Date.now() < deadline) {
          const result = await mariadbContainer.exec([
            'mariadb',
            '-uroot',
            '-ppassword',
            'gwangsan_db',
            '-N',
            '-B',
            '-e',
            `SELECT CONCAT(COUNT(DISTINCT m.message_id), ':',
              COALESCE(GROUP_CONCAT(i.image_id ORDER BY i.image_id), ''))
             FROM tbl_chat_message m
             LEFT JOIN tbl_chat_message_image i ON i.message_id = m.message_id
             WHERE m.message_id = ${messageId} AND m.room_id = ${roomId};`,
          ]);
          if (result.exitCode !== 0) throw new Error(result.output);
          committed = result.stdout.trim();
          if (committed === expectedCommit) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(committed).toBe(expectedCommit);

        // History reads update read-state; issue one read only after the async write commits.
        const response = await request(springUrl)
          .get(`/api/chat/${roomId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        // Spring serializes Long IDs as JSON numbers; preserve their digits before parsing.
        const body: unknown = JSON.parse(
          response.text.replace(/("messageId"\s*:\s*)(\d+)/g, '$1"$2"'),
        );
        if (
          typeof body !== 'object' ||
          body === null ||
          !('messages' in body) ||
          !Array.isArray(body.messages)
        )
          throw new Error('Invalid chat history response');
        const persisted: unknown = body.messages.find(
          (message: unknown) =>
            typeof message === 'object' &&
            message !== null &&
            'messageId' in message &&
            message.messageId === messageId,
        );
        expect(persisted).toMatchObject({
          roomId,
          messageType,
          content: content ?? '',
          messageId: String(received.messageId),
          images,
          senderId: 1,
          isMine: true,
        });
      } finally {
        socket.disconnect();
        await redis.del(`auth:cache:${phoneNumber}`);
      }
    },
    25000,
  );
});
