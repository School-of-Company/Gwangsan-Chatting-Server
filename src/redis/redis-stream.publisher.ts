import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisStreamPublisher {
  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  async publish(
    streamKey: string,
    fields: Record<string, string>,
  ): Promise<string> {
    return this.client.xadd(
      streamKey,
      'MAXLEN',
      '~',
      '10000',
      '*',
      ...Object.entries(fields).flat(),
    ) as Promise<string>;
  }
}
