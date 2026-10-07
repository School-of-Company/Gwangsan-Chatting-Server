import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server as HttpServer } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import * as request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { AppModule } from '../src/app.module';
import { ChatGateway } from '../src/chat/chat.gateway';

const SECRET = 'local-message-events-secret';
const JWT_SECRET = 'local-message-events-jwt';
const ROOM = 7;
const TIME = '2026-09-30T12:00:00.123456';
const ID = '9223372036854775807';
const updated = {
  roomId: ROOM,
  messageId: ID,
  content: 'edited content',
  editedAt: TIME,
  roomListChanged: true,
  latestMessage: {
    messageId: ID,
    content: 'edited content',
    messageType: 'TEXT',
    createdAt: '2026-09-30T11:59:00',
    editedAt: TIME,
  },
};
const deleted = {
  roomId: ROOM,
  messageId: ID,
  roomListChanged: true,
  latestMessage: null,
};
const system = {
  roomId: ROOM,
  messageId: '-12',
  senderId: 1,
  content: 'actor님이 예약을 취소했어요',
  createdAt: TIME,
};
const routes = [
  ['message-updated', updated],
  ['message-deleted', deleted],
  ['system-message', system],
] as const;

describe('Saved chat events over HTTP and Socket.IO', () => {
  let app: INestApplication;
  let url: string;
  let redis: Redis;
  let container: StartedTestContainer;
  let spring: HttpServer;
  let actor: Socket;
  let actorDevice: Socket;
  let other: Socket;
  let outsider: Socket;
  let sockets: Socket[] = [];
  let requests: string[] = [];
  let outsiderRooms = [9];
  const events = new Map<Socket, { event: string; payload: unknown }[]>();
  const originalEnv = { ...process.env };

  function nextEvent(
    socket: Socket,
    event: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const listener = (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        socket.off(event, listener);
        reject(new Error(`${event} timeout`));
      }, 5000);
      socket.once(event, listener);
    });
  }

  async function connect(memberId: number): Promise<Socket> {
    const token = jwt.sign({ sub: String(memberId) }, JWT_SECRET, {
      expiresIn: '1h',
    });
    const socket = io(`${url}/api/chat`, {
      auth: { token: `Bearer ${token}` },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    events.set(socket, []);
    socket.onAny((event: string, payload: unknown) => {
      if (event !== 'testBarrier') events.get(socket)?.push({ event, payload });
    });
    socket.on('testBarrier', (ack: () => void) => ack());
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    // Wait on the actual adapter join rather than on a timer.
    const namespace = app.get(ChatGateway).server;
    const room = `roomId=${memberId === 3 ? 9 : ROOM}`;
    const serverSocket = namespace.sockets.get(socket.id ?? '');
    if (!serverSocket) throw new Error('Missing server socket');
    if (!serverSocket.rooms.has(room)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          namespace.adapter.off('join-room', joined);
          reject(new Error('auto join timeout'));
        }, 5000);
        const joined = (joinedRoom: string, socketId: string) => {
          if (joinedRoom !== room || socketId !== socket.id) return;
          clearTimeout(timer);
          namespace.adapter.off('join-room', joined);
          resolve();
        };
        namespace.adapter.on('join-room', joined);
      });
    }
    return socket;
  }

  async function drainEvents(): Promise<void> {
    for (const socket of await app.get(ChatGateway).server.fetchSockets()) {
      await socket.timeout(5000).emitWithAck('testBarrier');
    }
  }

  function post(path: string, body: unknown, secret = SECRET) {
    return request(url)
      .post(`/api/internal/chat/${path}`)
      .set('Content-Type', 'application/json')
      .set('x-internal-secret', secret)
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  }

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    spring = createServer((req, res) => {
      res.setHeader('Connection', 'close');
      const path = req.url ?? '';
      requests.push(path);
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const decoded = jwt.verify(token, JWT_SECRET);
      if (typeof decoded === 'string') throw new Error('Unexpected JWT');
      const memberId = Number(decoded.sub);
      res.setHeader('Content-Type', 'application/json');
      if (path === '/api/auth') {
        res.end(
          JSON.stringify({
            memberId,
            nickname: memberId === 1 ? 'actor' : 'other',
          }),
        );
      } else if (path === '/api/chat/rooms') {
        res.end(
          JSON.stringify(
            (memberId === 3 ? outsiderRooms : [ROOM]).map((roomId) => ({
              roomId,
            })),
          ),
        );
      } else if (
        path.startsWith(`/api/chat/room/${ROOM}/sendable`) &&
        memberId !== 3
      ) {
        res.end(
          JSON.stringify({
            images: [
              { imageId: 11, imageUrl: 'https://images.example/11.jpg' },
            ],
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      spring.listen(0, '127.0.0.1', resolve),
    );
    const address = spring.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing Spring fixture address');
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: JWT_SECRET,
      INTERNAL_API_SECRET: SECRET,
      SPRING_SERVER_URL: `http://127.0.0.1:${address.port}`,
      REDIS_HOST: container.getHost(),
      REDIS_PORT: String(container.getMappedPort(6379)),
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
    actor = await connect(1);
    actorDevice = await connect(1);
    other = await connect(2);
    outsider = await connect(3);
  }, 60000);

  beforeEach(async () => {
    await drainEvents();
    for (const received of events.values()) received.length = 0;
    requests = [];
    outsiderRooms = [9];
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets = [];
    await app?.close();
    await redis?.quit();
    if (spring) {
      spring.closeAllConnections();
      await new Promise<void>((resolve) => spring.close(() => resolve()));
    }
    await container?.stop();
    for (const key of [
      'JWT_ACCESS_SECRET',
      'INTERNAL_API_SECRET',
      'SPRING_SERVER_URL',
      'REDIS_HOST',
      'REDIS_PORT',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('delivers exact Spring numeric Long update and room head to both members outside the room screen', async () => {
    const receives = [actor, actorDevice, other].map((socket) =>
      nextEvent(socket, 'messageUpdated'),
    );
    const lists = [actor, other].map((socket) =>
      nextEvent(socket, 'updateRoomList'),
    );
    const raw = JSON.stringify(updated).replaceAll(`"${ID}"`, ID);

    await post('message-updated', raw).expect(201, { ok: true });
    expect(await Promise.all(receives)).toEqual(
      Array(3).fill({
        roomId: ROOM,
        messageId: ID,
        content: updated.content,
        editedAt: TIME,
      }),
    );
    expect(await Promise.all(lists)).toEqual(
      Array(2).fill({
        roomId: ROOM,
        messageId: ID,
        lastMessage: updated.content,
        lastMessageType: 'TEXT',
        lastMessageTime: updated.latestMessage.createdAt,
      }),
    );
    await drainEvents();
    expect(events.get(outsider)).toEqual([]);
    expect(requests).toEqual([]);
    expect(await redis.keys('chat:*')).toEqual([]);
  });

  it.each([
    null,
    {
      messageId: '123',
      content: null,
      messageType: 'IMAGE',
      createdAt: TIME,
      editedAt: null,
    },
    {
      messageId: '-12',
      content: system.content,
      messageType: 'SYSTEM',
      createdAt: TIME,
      editedAt: null,
    },
  ])(
    'delivers deletion with authoritative replacement %p including an empty head',
    async (latestMessage) => {
      const receive = nextEvent(other, 'messageDeleted');
      const list = nextEvent(other, 'updateRoomList');

      await post('message-deleted', { ...deleted, latestMessage }).expect(201);
      expect(await receive).toEqual({ roomId: ROOM, messageId: ID });
      expect(await list).toEqual({
        roomId: ROOM,
        messageId: latestMessage?.messageId ?? null,
        lastMessage: latestMessage?.content ?? null,
        lastMessageType: latestMessage?.messageType ?? null,
        lastMessageTime: latestMessage?.createdAt ?? null,
      });
      await drainEvents();
      expect(events.get(outsider)).toEqual([]);
    },
  );

  it.each([
    [
      'message-updated',
      { ...updated, roomListChanged: false, latestMessage: null },
      'messageUpdated',
    ],
    [
      'message-deleted',
      { ...deleted, roomListChanged: false },
      'messageDeleted',
    ],
  ])(
    'does not change the room list for a non-head %s',
    async (path, body, event) => {
      const receive = nextEvent(other, event);

      await post(path, body).expect(201);
      await receive;
      await drainEvents();
      expect(events.get(other)?.map((item) => item.event)).toEqual([event]);
    },
  );

  it.each([1, 2])(
    'delivers saved SYSTEM with sender %i and REST-compatible direction without persisting or changing the list',
    async (senderId) => {
      const receives = [actor, actorDevice, other].map((socket) =>
        nextEvent(socket, 'receiveMessage'),
      );
      const body = { ...system, senderId };

      await post(
        'system-message',
        JSON.stringify(body).replace('"-12"', '-12'),
      ).expect(201);
      const messages = await Promise.all(receives);
      expect(messages).toEqual(
        [1, 1, 2].map((memberId) => ({
          ...body,
          messageType: 'SYSTEM',
          editedAt: null,
          images: [],
          checked: true,
          isMine: memberId === senderId,
        })),
      );
      await drainEvents();
      for (const socket of [actor, actorDevice, other]) {
        expect(events.get(socket)?.map((item) => item.event)).toEqual([
          'receiveMessage',
        ]);
      }
      expect(events.get(outsider)).toEqual([]);
      expect(await redis.keys('chat:*')).toEqual([]);
      expect(requests).toEqual([]);
    },
  );

  describe.each(routes)('%s trust boundary', (path, body) => {
    it.each(['', 'bad', SECRET.slice(1), `${SECRET.slice(0, -1)}X`])(
      'rejects secret %p with no socket events',
      async (secret) => {
        await post(path, body, secret).expect(401);
        await drainEvents();
        expect([...events.values()].flat()).toEqual([]);
      },
    );

    it.each([
      { roomId: 0 },
      { roomId: -1 },
      { roomId: 1.5 },
      { roomId: Number.MAX_SAFE_INTEGER + 1 },
      { roomId: '7' },
      { roomId: null },
      { messageId: null },
      { messageId: 0 },
      { messageId: 1.5 },
      { messageId: '1.5' },
      { messageId: '01' },
      { messageId: '1e3' },
      { messageId: '9223372036854775808' },
      { messageId: '-9223372036854775809' },
      { unexpected: true },
      { isMine: true },
      { messageType: 'SYSTEM' },
    ])('rejects malformed payload %p without broadcasting', async (invalid) => {
      await post(path, { ...body, ...invalid }).expect(400);
      await drainEvents();
      expect([...events.values()].flat()).toEqual([]);
    });

    it.each([null, [], {}, 'not-json'])(
      'rejects incomplete body %p',
      async (invalid) => {
        await post(path, invalid).expect(400);
      },
    );
  });

  it.each([
    ['message-updated', { ...updated, content: ' ' }],
    ['message-updated', { ...updated, content: null }],
    ['message-updated', { ...updated, editedAt: '2026-02-30T12:00:00' }],
    ['message-updated', { ...updated, editedAt: '2026-09-30' }],
    ['message-updated', { ...updated, roomListChanged: 'true' }],
    ['message-updated', { ...updated, latestMessage: null }],
    ['message-updated', { ...updated, roomListChanged: false }],
    ['message-updated', { ...updated, latestMessage: {} }],
    ['message-updated', { ...updated, latestMessage: [] }],
    [
      'message-updated',
      {
        ...updated,
        latestMessage: { ...updated.latestMessage, messageType: 'UNKNOWN' },
      },
    ],
    [
      'message-updated',
      { ...updated, latestMessage: { ...updated.latestMessage, roomId: 8 } },
    ],
    [
      'message-updated',
      {
        ...updated,
        latestMessage: { ...updated.latestMessage, createdAt: 'invalid' },
      },
    ],
    ['message-deleted', { ...deleted, latestMessage: undefined }],
    ['system-message', { ...system, messageId: ID }],
    ['system-message', { ...system, senderId: 0 }],
    ['system-message', { ...system, senderId: Number.MAX_SAFE_INTEGER + 1 }],
    ['system-message', { ...system, senderId: '1' }],
    ['system-message', { ...system, content: '' }],
    ['system-message', { ...system, createdAt: 'invalid' }],
  ])('rejects invalid %s contract %p', async (path, body) => {
    await post(path, body).expect(400);
    await drainEvents();
    expect([...events.values()].flat()).toEqual([]);
  });

  it('rejects unauthorized joinRoom before internal events can leak', async () => {
    const exception = nextEvent(outsider, 'exception');

    outsider.emit('joinRoom', ROOM);
    await exception;
    const receive = nextEvent(other, 'messageDeleted');
    await post('message-deleted', deleted).expect(201);
    await receive;
    await drainEvents();
    expect(events.get(outsider)?.map((item) => item.event)).toEqual([
      'exception',
    ]);
  });

  it('allows joinRoom for a newly listed room', async () => {
    outsiderRooms = [9, 8];
    const namespace = app.get(ChatGateway).server;
    const joined = new Promise<void>((resolve) => {
      const listener = (room: string, socketId: string) => {
        if (room !== 'roomId=8' || socketId !== outsider.id) return;
        namespace.adapter.off('join-room', listener);
        resolve();
      };
      namespace.adapter.on('join-room', listener);
    });

    outsider.emit('joinRoom', 8);
    await joined;
    const receive = nextEvent(outsider, 'messageDeleted');
    await post('message-deleted', { ...deleted, roomId: 8 }).expect(201);
    expect(await receive).toEqual({ roomId: 8, messageId: ID });
  });

  it('rejects client SYSTEM sendMessage before XADD', async () => {
    const exception = nextEvent(actor, 'exception');

    actor.emit('sendMessage', {
      roomId: ROOM,
      messageType: 'SYSTEM',
      content: 'forged',
    });
    await exception;
    await drainEvents();
    expect(await redis.keys('chat:*')).toEqual([]);
    expect(events.get(other)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('does not expose internal HTTP handlers as socket commands', async () => {
    for (const [path, body] of routes) actor.emit(path, body);
    actor.emit('messageUpdated', updated);
    actor.emit('messageDeleted', deleted);
    actor.emit('systemMessage', system);
    const receive = nextEvent(other, 'messageDeleted');

    await post('message-deleted', deleted).expect(201);
    await receive;
    await drainEvents();
    expect(events.get(other)?.map((item) => item.event)).toEqual([
      'messageDeleted',
      'updateRoomList',
    ]);
    expect(await redis.keys('chat:*')).toEqual([]);
  });

  it.each(['', 'invalid'])(
    'rejects unauthenticated socket token %p',
    async (token) => {
      const socket = io(`${url}/api/chat`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve) =>
        socket.once('connect_error', () => resolve()),
      );
      expect(socket.connected).toBe(false);
    },
  );

  it.each([
    { messageType: 'TEXT', content: 'hello', imageIds: [], images: null },
    {
      messageType: 'IMAGE',
      content: null,
      imageIds: [11],
      images: [{ imageId: 11, imageUrl: 'https://images.example/11.jpg' }],
    },
  ])(
    'preserves $messageType send direction and one Redis write',
    async ({ messageType, content, imageIds, images }) => {
      const own = nextEvent(actor, 'receiveMessage');
      const peer = nextEvent(other, 'receiveMessage');
      const before = await redis.xlen(`chat:room:${ROOM}:messages`);

      actor.emit('sendMessage', {
        roomId: ROOM,
        content,
        imageIds,
        messageType,
      });
      const ownMessage = await own;
      expect(ownMessage).toMatchObject({
        roomId: ROOM,
        content,
        messageType,
        images,
        senderId: 1,
        senderNickname: 'actor',
        isMine: true,
      });
      expect(await peer).toEqual({ ...ownMessage, isMine: false });
      expect(await redis.xlen(`chat:room:${ROOM}:messages`)).toBe(before + 1);
      await drainEvents();
      expect(events.get(outsider)).toEqual([]);
    },
  );
});
