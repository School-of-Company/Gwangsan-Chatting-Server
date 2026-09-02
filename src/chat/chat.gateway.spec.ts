import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { AuthService } from '../auth/auth.service';
import { ChatNotificationService } from './chat-notification.service';
import { MessageType } from './dto/message-type.enum';
import { WsException } from '@nestjs/websockets';

const mockChatService = {
  sendMessage: jest.fn(),
  fetchJoinedRoomIds: jest.fn(),
};

const mockAuthService = {
  validateToken: jest.fn(),
};

const mockChatNotificationService = {
  setServer: jest.fn(),
};

describe('ChatGateway', () => {
  let gateway: ChatGateway;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        {
          provide: ChatService,
          useValue: mockChatService,
        },
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: ChatNotificationService,
          useValue: mockChatNotificationService,
        },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleLeaveRoom', () => {
    // 연결 시 자동 join 한 방에서 내보내면 목록 화면에서 실시간 갱신이 끊긴다.
    it('방에서 내보내지 않는다', () => {
      const client = {
        id: 'socket-1',
        data: { memberId: 9, nickname: '테스터', token: 'Bearer t' },
        leave: jest.fn(),
        join: jest.fn(),
      };

      gateway.handleLeaveRoom(16550, client as never);

      expect(client.leave).not.toHaveBeenCalled();
    });

    it('유효하지 않은 roomId 는 거부한다', () => {
      const client = {
        id: 'socket-1',
        data: { memberId: 9, nickname: '테스터', token: 'Bearer t' },
        leave: jest.fn(),
      };

      expect(() => gateway.handleLeaveRoom(0, client as never)).toThrow();
      expect(client.leave).not.toHaveBeenCalled();
    });
  });

  describe('handleConnection', () => {
    const makeClient = () => ({
      id: 'socket-1',
      connected: true,
      data: { memberId: 9, nickname: '테스터', token: 'Bearer t' },
      join: jest.fn(),
    });

    // join 이 handleConnection 안에서 비동기로 일어나므로 마이크로태스크를 비운다.
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('참여 중인 모든 방에 자동으로 join 한다', async () => {
      mockChatService.fetchJoinedRoomIds.mockResolvedValue([3, 7]);
      const client = makeClient();

      gateway.handleConnection(client as never);
      await flush();

      expect(mockChatService.fetchJoinedRoomIds).toHaveBeenCalledWith(
        'Bearer t',
      );
      expect(client.join).toHaveBeenCalledWith('memberId=9');
      expect(client.join).toHaveBeenCalledWith('roomId=3');
      expect(client.join).toHaveBeenCalledWith('roomId=7');
    });

    it('방 목록 조회에 실패해도 연결을 유지한다', async () => {
      mockChatService.fetchJoinedRoomIds.mockRejectedValue(
        new Error('spring down'),
      );
      const client = makeClient();

      gateway.handleConnection(client as never);
      await flush();

      expect(client.join).toHaveBeenCalledWith('memberId=9');
      expect(client.join).toHaveBeenCalledTimes(1);
    });

    it('조회 도중 연결이 끊기면 join 하지 않는다', async () => {
      mockChatService.fetchJoinedRoomIds.mockImplementation(() => {
        client.connected = false;
        return Promise.resolve([3]);
      });
      const client = makeClient();

      gateway.handleConnection(client as never);
      await flush();

      expect(client.join).not.toHaveBeenCalledWith('roomId=3');
    });
  });

  describe('handleMessage', () => {
    const makeClient = () => ({
      id: 'socket-1',
      data: { memberId: 9, nickname: '테스터', token: 'Bearer t' },
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    });

    const makeServer = () => ({
      in: jest.fn().mockReturnValue({ emit: jest.fn() }),
    });

    const message = {
      roomId: 42,
      content: '안녕',
      messageType: MessageType.TEXT,
      imageIds: undefined,
    };

    it('차단 관계면 브로드캐스트하지 않고 발신자에게만 error 를 보낸다', async () => {
      mockChatService.sendMessage.mockRejectedValue(
        new WsException('차단한 사용자입니다.'),
      );
      const client = makeClient();
      const server = makeServer();
      gateway.server = server as never;

      await gateway.handleMessage(message as never, client as never);

      expect(client.to).not.toHaveBeenCalled();
      expect(server.in).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: '차단한 사용자입니다.',
      });
    });

    it('정상 전송이면 토큰을 넘기고 방에 브로드캐스트한다', async () => {
      mockChatService.sendMessage.mockResolvedValue({
        roomId: 42,
        content: '안녕',
        messageType: MessageType.TEXT,
        createdAt: new Date(),
      });
      const client = makeClient();
      const server = makeServer();
      gateway.server = server as never;

      await gateway.handleMessage(message as never, client as never);

      expect(mockChatService.sendMessage).toHaveBeenCalledWith(
        message,
        9,
        '테스터',
        'Bearer t',
      );
      expect(client.to).toHaveBeenCalledWith('roomId=42');
      expect(server.in).toHaveBeenCalledWith('roomId=42');
    });
  });
});
