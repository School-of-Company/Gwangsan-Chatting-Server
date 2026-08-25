import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { RedisStreamPublisher } from './redis-stream.publisher';
import { LoggingUtil } from '../common/logging.util';

@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: async (): Promise<Redis> => {
        const client = new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
        });

        client.on('error', (err) =>
          LoggingUtil.error('RedisModule', 'Redis 연결 오류', err),
        );

        await client.ping();
        LoggingUtil.log('RedisModule', 'Redis 연결 성공');

        return client;
      },
    },
    RedisService,
    RedisStreamPublisher,
  ],
  exports: [RedisService, RedisStreamPublisher],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  onModuleDestroy() {
    void this.client.quit();
  }
}
