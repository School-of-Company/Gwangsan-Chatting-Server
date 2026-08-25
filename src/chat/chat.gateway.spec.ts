import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { AuthService } from '../auth/auth.service';
import { ChatNotificationService } from './chat-notification.service';

const mockChatService = {
  sendMessage: jest.fn(),
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
});
