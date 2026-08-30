import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

const JWT_SECRET = 'test-secret';
const INTERNAL_API_SECRET = 'internal-test-secret';

describe('Chat Stream E2E', () => {
  let app: INestApplication;
  let redis: Redis;
  let redisContainer: StartedTestContainer;

  beforeAll(async () => {
    jest.setTimeout(60000);

    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);

    process.env.JWT_ACCESS_SECRET = JWT_SECRET;
    process.env.SPRING_SERVER_URL = 'http://localhost:8080';
    process.env.INTERNAL_API_SECRET = INTERNAL_API_SECRET;
    process.env.REDIS_HOST = redisHost;
    process.env.REDIS_PORT = String(redisPort);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0);

    redis = new Redis({ host: redisHost, port: redisPort });
  }, 60000);

  afterAll(async () => {
    await redis?.quit();
    await app?.close();
    await redisContainer?.stop();
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
    const server = app.getHttpServer() as import('net').Server;
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
        5000,
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

  describe('sendMessage', () => {
    const roomId = 99;
    const memberId = 1;
    const nickname = 'tester';
    const phoneNumber = 'test-phone-001';
    const streamKey = `chat:room:${roomId}:messages`;
    let socket: Socket;

    beforeAll(async () => {
      await seedAuthCache(phoneNumber, memberId, nickname);
      const token = makeToken(phoneNumber);
      socket = await connect(getPort(), token);
      socket.emit('joinRoom', roomId);
      await new Promise((r) => setTimeout(r, 100));
    });

    afterAll(async () => {
      socket.disconnect();
      await redis.del(streamKey);
      await redis.del(`auth:cache:${phoneNumber}`);
    });

    it('receiveMessage 이벤트를 발신자에게 보낸다', async () => {
      const received = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('receiveMessage timeout')),
            5000,
          );
          socket.on('receiveMessage', (data: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(data);
          });
          socket.emit('sendMessage', {
            roomId,
            content: '안녕하세요',
            imageIds: [],
            messageType: 'TEXT',
          });
        },
      );

      expect(received.roomId).toBe(roomId);
      expect(received.content).toBe('안녕하세요');
      expect(received.senderId).toBe(memberId);
      expect(received.senderNickname).toBe(nickname);
      expect(received.isMine).toBe(true);
    });

    it('Redis Stream에 메시지를 발행한다', async () => {
      const entries = await redis.xrevrange(streamKey, '+', '-', 'COUNT', 1);
      expect(entries.length).toBeGreaterThan(0);

      const fields: Record<string, string> = {};
      const raw = entries[0][1];
      for (let i = 0; i < raw.length; i += 2) {
        fields[raw[i]] = raw[i + 1];
      }

      expect(fields.roomId).toBe(String(roomId));
      expect(fields.senderId).toBe(String(memberId));
      expect(fields.content).toBe('안녕하세요');
      expect(fields.messageType).toBe('TEXT');
    });
  });

  describe('handleConnection', () => {
    it('토큰 없이 연결하면 connect_error가 발생한다', async () => {
      const port = getPort();
      await new Promise<void>((resolve, reject) => {
        const socket = io(`http://localhost:${port}/api/chat`, {
          auth: { token: '' },
          transports: ['websocket'],
        });
        const timer = setTimeout(
          () => reject(new Error('connect_error timeout')),
          5000,
        );
        socket.on('connect_error', () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        });
      });
    });

    it('만료된 토큰으로 연결하면 connect_error가 발생한다', async () => {
      const expiredToken = jwt.sign({ sub: 'expired-user' }, JWT_SECRET, {
        expiresIn: '-1s',
      });
      const port = getPort();
      await new Promise<void>((resolve, reject) => {
        const socket = io(`http://localhost:${port}/api/chat`, {
          auth: { token: expiredToken },
          transports: ['websocket'],
        });
        const timer = setTimeout(
          () => reject(new Error('connect_error timeout')),
          5000,
        );
        socket.on('connect_error', () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        });
      });
    });
  });

  describe('joinRoom / leaveRoom', () => {
    const roomId = 88;
    const memberId = 2;
    const nickname = 'roomTester';
    const phoneNumber = 'test-phone-002';

    let sender: Socket;
    let receiver: Socket;

    beforeAll(async () => {
      await seedAuthCache(phoneNumber, memberId, nickname);
      await seedAuthCache('receiver-phone', 3, 'receiver');

      const port = getPort();
      sender = await connect(port, makeToken(phoneNumber));
      receiver = await connect(port, makeToken('receiver-phone'));

      await new Promise((r) => setTimeout(r, 300));

      sender.emit('joinRoom', roomId);
      receiver.emit('joinRoom', roomId);
      await new Promise((r) => setTimeout(r, 300));
    });

    afterAll(async () => {
      sender.disconnect();
      receiver.disconnect();
      await redis.del(`auth:cache:${phoneNumber}`);
      await redis.del('auth:cache:receiver-phone');
      await redis.del(`chat:room:${roomId}:messages`);
    });

    it('같은 방의 다른 클라이언트에게 receiveMessage가 전달된다', async () => {
      const receiverPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('receiveMessage timeout')),
            5000,
          );
          receiver.on('receiveMessage', (data: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(data);
          });
        },
      );

      sender.emit('sendMessage', {
        roomId,
        content: '브로드캐스트 테스트',
        imageIds: [],
        messageType: 'TEXT',
      });

      const received = await receiverPromise;
      expect(received.content).toBe('브로드캐스트 테스트');
      expect(received.isMine).toBe(false);
    });

    // 연결 시 참여 중인 모든 방에 자동 join 하므로, 화면을 벗어나 leaveRoom 을 보내도
    // 방에서 내보내지 않는다. 내보내면 목록 화면에 있는 동안 새 메시지를 받지 못한다.
    it('leaveRoom 을 보내도 참여자는 계속 메시지를 받는다', async () => {
      receiver.emit('leaveRoom', roomId);
      await new Promise((r) => setTimeout(r, 100));

      const received = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        receiver.once('receiveMessage', () => {
          clearTimeout(timer);
          resolve(true);
        });
        sender.emit('sendMessage', {
          roomId,
          content: 'leaveRoom 후에도 받아야 함',
          imageIds: [],
          messageType: 'TEXT',
        });
      });

      expect(received).toBe(true);
    });
  });

  describe('transaction-state internal event', () => {
    const roomId = 77;
    const targetMemberId = 4;
    const otherMemberId = 5;
    const targetPhoneNumber = 'test-phone-003';
    const otherPhoneNumber = 'test-phone-004';
    let targetSocket: Socket;
    let otherSocket: Socket;

    beforeAll(async () => {
      await seedAuthCache(
        targetPhoneNumber,
        targetMemberId,
        'transaction-listener',
      );
      await seedAuthCache(otherPhoneNumber, otherMemberId, 'other-listener');
      targetSocket = await connect(getPort(), makeToken(targetPhoneNumber));
      otherSocket = await connect(getPort(), makeToken(otherPhoneNumber));
      targetSocket.emit('joinRoom', roomId);
      otherSocket.emit('joinRoom', roomId);
      await new Promise((r) => setTimeout(r, 100));
    });

    afterAll(async () => {
      targetSocket.disconnect();
      otherSocket.disconnect();
      await redis.del(`auth:cache:${targetPhoneNumber}`);
      await redis.del(`auth:cache:${otherPhoneNumber}`);
    });

    it('내부 API 호출 시 방 참여자 양쪽 모두에게 transactionStateChanged 이벤트를 보낸다', async () => {
      const createdAt = new Date().toISOString();
      const targetEventPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('transactionStateChanged timeout')),
            5000,
          );
          targetSocket.once(
            'transactionStateChanged',
            (data: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(data);
            },
          );
        },
      );
      const otherEventPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('상대방 transactionStateChanged timeout')),
            5000,
          );
          otherSocket.once(
            'transactionStateChanged',
            (data: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(data);
            },
          );
        },
      );

      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', INTERNAL_API_SECRET)
        .send({
          roomId,
          targetMemberId,
          productId: 123,
          isCompleted: true,
          createdAt,
        })
        .expect(201, { ok: true });

      const expected = {
        roomId,
        targetMemberId,
        productId: 123,
        isCompleted: true,
        createdAt,
      };
      // 거래 상태는 방 단위 상태이므로 targetMemberId 가 지정돼도 양쪽 다 받아야 한다.
      await expect(targetEventPromise).resolves.toMatchObject(expected);
      await expect(otherEventPromise).resolves.toMatchObject(expected);
    });

    it('isReserved가 포함되면 whitelist에 걸리지 않고 이벤트에 실려간다', async () => {
      const createdAt = new Date().toISOString();
      const targetEventPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('transactionStateChanged timeout')),
            5000,
          );
          targetSocket.once(
            'transactionStateChanged',
            (data: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(data);
            },
          );
        },
      );

      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', INTERNAL_API_SECRET)
        .send({
          roomId,
          targetMemberId,
          productId: 123,
          isCompleted: false,
          isReserved: true,
          createdAt,
        })
        .expect(201, { ok: true });

      await expect(targetEventPromise).resolves.toMatchObject({
        roomId,
        targetMemberId,
        productId: 123,
        isCompleted: false,
        isReserved: true,
        createdAt,
      });
    });

    it('requestedBySeller가 whitelist에 걸리지 않고 이벤트에 실려간다', async () => {
      const createdAt = new Date().toISOString();
      const eventPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('transactionStateChanged timeout')),
            5000,
          );
          targetSocket.once(
            'transactionStateChanged',
            (data: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(data);
            },
          );
        },
      );

      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', INTERNAL_API_SECRET)
        .send({
          roomId,
          productId: 123,
          isCompleted: false,
          isReserved: false,
          createdAt,
          requestedBySeller: true,
        })
        .expect(201, { ok: true });

      await expect(eventPromise).resolves.toMatchObject({
        roomId,
        productId: 123,
        isCompleted: false,
        isReserved: false,
        createdAt,
        requestedBySeller: true,
      });
    });

    // 거래 확정/롤백 후에는 활성 거래 요청이 없어 Spring 이 null 을 보낸다.
    // createdAt 이 필수 검증이면 이 요청이 400 으로 반려된다.
    it('활성 거래 요청이 없어 createdAt과 requestedBySeller가 null이어도 통과한다', async () => {
      const eventPromise = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('transactionStateChanged timeout')),
            5000,
          );
          targetSocket.once(
            'transactionStateChanged',
            (data: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(data);
            },
          );
        },
      );

      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', INTERNAL_API_SECRET)
        .send({
          roomId,
          productId: 123,
          isCompleted: false,
          isReserved: false,
          createdAt: null,
          requestedBySeller: null,
        })
        .expect(201, { ok: true });

      const received = await eventPromise;
      expect(received).toMatchObject({
        roomId,
        productId: 123,
        isCompleted: false,
        isReserved: false,
      });
      expect(received.createdAt ?? null).toBeNull();
      expect(received.requestedBySeller ?? null).toBeNull();
    });

    it('내부 시크릿이 다르면 401을 반환한다', async () => {
      await request(app.getHttpServer())
        .post('/api/internal/chat/transaction-state')
        .set('x-internal-secret', 'wrong-secret')
        .send({
          roomId,
          targetMemberId,
          productId: 123,
          isCompleted: true,
          createdAt: new Date().toISOString(),
        })
        .expect(401);
    });
  });
});
