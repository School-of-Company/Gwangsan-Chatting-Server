import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { LoggingUtil } from '../common/logging.util';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  async onModuleInit() {
    this.client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });

    this.client.on('error', (err) =>
      LoggingUtil.error('RedisService', 'Redis 연결 오류', err),
    );

    await this.client.ping();
    LoggingUtil.log('RedisService', 'Redis 연결 성공');
  }

  onModuleDestroy() {
    void this.client.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
