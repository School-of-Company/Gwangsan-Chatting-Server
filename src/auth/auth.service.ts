import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { MemberInfo } from '../chat/dto/chat-member-info.dto';
import { LoggingUtil } from '../common/logging.util';
import { RedisService } from '../redis/redis.service';

const SPRING_REQUEST_TIMEOUT_MS = 5000;

/**
 * 인증 캐시 키. sub(전화번호)가 아닌 토큰 기준이다.
 * sub 로 묶으면 탈퇴 후 같은 번호로 재가입한 회원이 새 토큰으로 로그인해도
 * 예전 memberId 가 나와 메시지가 저장되지 않는다(Gwangsan-Server#464).
 * 원문 토큰 대신 해시를 써서 키에 토큰·전화번호가 남지 않게 한다.
 */
export function authCacheKey(rawToken: string): string {
  return `auth:cache:${createHash('sha256').update(rawToken).digest('hex')}`;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private jwtSecret: string;
  private springUrl: string;
  private readonly httpClient: AxiosInstance = axios.create({
    timeout: SPRING_REQUEST_TIMEOUT_MS,
    httpAgent: new HttpAgent({ keepAlive: true }),
    httpsAgent: new HttpsAgent({ keepAlive: true }),
  });

  constructor(private readonly redisService: RedisService) {}

  onModuleInit() {
    const jwtSecret = process.env.JWT_ACCESS_SECRET;
    const springUrl = process.env.SPRING_SERVER_URL;

    if (!jwtSecret) {
      throw new InternalServerErrorException(
        'JWT_ACCESS_SECRET이 설정되지 않았습니다.',
      );
    }
    if (!springUrl) {
      throw new InternalServerErrorException(
        'SPRING_SERVER_URL이 설정되지 않았습니다.',
      );
    }

    this.jwtSecret = jwtSecret;
    this.springUrl = springUrl;
  }

  async validateToken(token: string): Promise<MemberInfo> {
    const rawToken = token.replace(/^Bearer\s+/i, '');

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(rawToken, this.jwtSecret) as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        LoggingUtil.error('AuthService', '만료된 토큰');
        throw new UnauthorizedException('만료된 토큰입니다.');
      }
      LoggingUtil.error('AuthService', '유효하지 않은 토큰', error);
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }

    const isBlacklisted = await this.redisService.exists(rawToken);
    if (isBlacklisted) {
      LoggingUtil.error('AuthService', '블랙리스트 토큰');
      throw new UnauthorizedException('로그아웃된 토큰입니다.');
    }

    if (!decoded.sub) {
      LoggingUtil.error('AuthService', 'JWT sub claim 없음');
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }

    const cacheKey = authCacheKey(rawToken);
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      try {
        LoggingUtil.log('AuthService', '토큰 캐시 히트');
        return JSON.parse(cached) as MemberInfo;
      } catch {
        LoggingUtil.error('AuthService', '캐시 파싱 실패, 캐시 삭제');
        await this.redisService.del(cacheKey);
      }
    }

    try {
      const response = await this.httpClient.get(`${this.springUrl}/api/auth`, {
        headers: { Authorization: token },
      });

      const memberInfo = response.data as MemberInfo;

      const ttl = decoded.exp
        ? decoded.exp - Math.floor(Date.now() / 1000)
        : 3600;
      if (ttl > 0) {
        await this.redisService.set(cacheKey, JSON.stringify(memberInfo), ttl);
      }

      LoggingUtil.log('AuthService', '토큰 검증 완료 (Spring 호출)');
      return memberInfo;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          LoggingUtil.error('AuthService', '토큰 인증 실패 (401)', error);
          throw new UnauthorizedException('인증에 실패했습니다.');
        }
        LoggingUtil.error('AuthService', 'Axios 오류 발생', error);
        throw new InternalServerErrorException(
          '서버 내부 오류가 발생했습니다.',
        );
      }
      throw error;
    }
  }
}
