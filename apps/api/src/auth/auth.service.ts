import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CLOCK, type Clock } from './login-rate-limiter.js';
import { verifyPassword } from './password-hash.js';
import { createSessionToken, verifySessionToken } from './session-token.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Checks credentials. The argon2id verification always runs, even for an unknown username, and the
   * username is compared in constant time on fixed-length digests, so there is no fast failure path.
   */
  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const usernameOk = timingSafeEqual(digest(username), digest(this.config.adminUsername));
    const passwordOk = await verifyPassword(this.config.adminPasswordHash, password);
    return usernameOk && passwordOk;
  }

  issueSessionToken(): string {
    return createSessionToken(this.config.sessionSecret, this.clock.now());
  }

  isValidSessionToken(token: string): boolean {
    return verifySessionToken(this.config.sessionSecret, token, this.clock.now());
  }

  get adminUsername(): string {
    return this.config.adminUsername;
  }

  get secureCookies(): boolean {
    return this.config.nodeEnv !== 'development';
  }
}
