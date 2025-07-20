import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { ISEND_CHAT_MESSAGE_SERVICE, IAUTH_TOKEN_SERVICE } from 'src/core/di.tokens';

const mockSendChatMessageService = {
  execute: jest.fn(),
  notifyReadStatusToSpring: jest.fn(),
};

const mockAuthTokenService = {
  execute: jest.fn(),
};

describe('ChatGateway', () => {
  let gateway: ChatGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        {
          provide: ISEND_CHAT_MESSAGE_SERVICE,
          useValue: mockSendChatMessageService,
        },
        {
          provide: IAUTH_TOKEN_SERVICE,
          useValue: mockAuthTokenService,
        },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
