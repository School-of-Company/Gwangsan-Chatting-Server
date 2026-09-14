import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import { validate } from 'class-validator';
import { ChatService } from './chat.service';
import { ChatMessageRequest } from './dto/chat-message-request.dto';
import { MessageType } from './dto/message-type.enum';
import { RedisStreamPublisher } from '../redis/redis-stream.publisher';

describe('ChatService image metadata', () => {
  let server: Server;
  let service: ChatService;
  let body: unknown;
  let status: number;
  let stall: boolean;
  let requestCount: number;
  let requestUrl: string | undefined;
  let authorization: string | undefined;
  const publish = jest.fn().mockResolvedValue('1-0');
  const originalUrl = process.env.SPRING_SERVER_URL;
  const images = [
    { imageId: 12, imageUrl: 'https://images.test/twelve.png' },
    { imageId: 11, imageUrl: 'https://images.test/eleven.png' },
    { imageId: 12, imageUrl: 'https://images.test/twelve.png' },
  ];
  const message: ChatMessageRequest = {
    roomId: 42,
    content: null,
    messageType: MessageType.IMAGE,
    imageIds: [12, 11, 12],
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requestCount += 1;
      requestUrl = req.url;
      authorization = req.headers.authorization;
      if (stall) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    process.env.SPRING_SERVER_URL = `http://127.0.0.1:${address.port}`;
    const module = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: RedisStreamPublisher, useValue: { publish } },
      ],
    }).compile();
    service = module.get(ChatService);
  });

  beforeEach(() => {
    publish.mockClear();
    status = 200;
    stall = false;
    requestCount = 0;
    body = { images };
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalUrl === undefined) delete process.env.SPRING_SERVER_URL;
    else process.env.SPRING_SERVER_URL = originalUrl;
  });

  it('returns authoritative images in request order and preserves stream IDs', async () => {
    const response = await service.sendMessage(
      message,
      9,
      'sender',
      'Bearer test',
    );

    expect(response.images).toEqual(images);
    expect(response.content).toBeNull();
    expect(response.senderId).toBe(9);
    expect(authorization).toBe('Bearer test');
    const url = new URL(requestUrl ?? '', 'http://spring.test');
    expect(url.pathname).toBe('/api/chat/room/42/sendable');
    expect(url.searchParams.getAll('imageIds')).toEqual(['12', '11', '12']);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'chat:room:42:messages',
      expect.objectContaining({ imageIds: '[12,11,12]', messageType: 'IMAGE' }),
    );
  });

  it('restores request order when metadata arrives in another order', async () => {
    body = { images: [images[1], images[0], images[2]] };
    expect(
      (await service.sendMessage(message, 9, 'sender', 'Bearer test')).images,
    ).toEqual(images);
  });

  it('keeps TEXT images null and makes the legacy request without imageIds', async () => {
    body = undefined;
    const response = await service.sendMessage(
      {
        ...message,
        messageType: MessageType.TEXT,
        content: 'hello',
        imageIds: [],
      },
      9,
      'sender',
      'Bearer test',
    );
    expect(response.images).toBeNull();
    expect(response.content).toBe('hello');
    expect(requestUrl).toBe('/api/chat/room/42/sendable');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    null,
    {},
    { images: null },
    { images: [] },
    { images: images.slice(0, 2) },
    {
      images: [
        images[0],
        images[1],
        { imageId: 99, imageUrl: 'https://images.test/x' },
      ],
    },
    {
      images: images.map((image) => ({
        ...image,
        imageId: String(image.imageId),
      })),
    },
    { images: images.map((image) => ({ ...image, imageUrl: ' ' })) },
    { images: images.map((image) => ({ ...image, imageUrl: null })) },
    {
      images: [
        images[0],
        images[1],
        { imageId: 12, imageUrl: 'https://images.test/conflict' },
      ],
    },
  ])('rejects invalid metadata before publication: %j', async (invalidBody) => {
    body = invalidBody;
    await expect(
      service.sendMessage(message, 9, 'sender', 'Bearer test'),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 500])(
    'does not publish on Spring HTTP %s',
    async (httpStatus) => {
      status = httpStatus;
      await expect(
        service.sendMessage(message, 9, 'sender', 'Bearer test'),
      ).rejects.toThrow(
        httpStatus === 404
          ? '채팅방 또는 이미지를 확인할 수 없습니다.'
          : undefined,
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('times out before publication without retrying the metadata request', async () => {
    stall = true;
    await expect(
      service.sendMessage(message, 9, 'sender', 'Bearer test'),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(requestCount).toBe(1);
  }, 10000);

  it('does not fetch again after Redis accepts the message', async () => {
    publish.mockImplementationOnce(() => {
      status = 500;
      return Promise.resolve('1-0');
    });
    expect(
      (await service.sendMessage(message, 9, 'sender', 'Bearer test')).images,
    ).toEqual(images);
    expect(requestCount).toBe(1);
  });

  it('does not automatically republish when Redis acknowledgement fails', async () => {
    publish.mockRejectedValueOnce(new Error('Redis acknowledgement lost'));
    await expect(
      service.sendMessage(message, 9, 'sender', 'Bearer test'),
    ).rejects.toThrow('Redis acknowledgement lost');
    expect(requestCount).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid request image ID %s',
    async (id) => {
      const request = Object.assign(new ChatMessageRequest(), message, {
        imageIds: [id],
      });
      const errors = await validate(request);
      expect(errors.some((error) => error.property === 'imageIds')).toBe(true);
    },
  );
});
