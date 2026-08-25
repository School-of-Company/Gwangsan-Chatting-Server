import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
