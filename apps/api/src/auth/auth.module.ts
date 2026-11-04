import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthorizationService } from './authorization.service.js';
import { CLOCK, LoginRateLimiter, systemClock } from './login-rate-limiter.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    AuthService,
    AuthorizationService,
    LoginRateLimiter,
    SessionGuard,
    // Default deny: registered globally, so every current and future controller is protected.
    { provide: APP_GUARD, useExisting: SessionGuard },
  ],
  exports: [AuthorizationService, AuthService],
})
export class AuthModule {}
