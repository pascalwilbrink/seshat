import { TypeOrmModule } from '@nestjs/typeorm';
import { Module, forwardRef } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { Workspace } from '../workspaces/workspace.entity.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthorizationService } from './authorization.service.js';
import { IdentityService } from './identity.service.js';
import { CLOCK, LoginRateLimiter, systemClock } from './login-rate-limiter.js';
import { SessionGuard } from './session.guard.js';

@Module({
  // forwardRef: AuthModule -> ApiKeysModule -> WorkspacesModule -> AuthModule is an import cycle; the deferred
  // edges (here and in WorkspacesModule) keep the module classes defined whatever order the files load in.
  imports: [forwardRef(() => ApiKeysModule), TypeOrmModule.forFeature([Workspace])],
  controllers: [AuthController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    AuthService,
    AuthorizationService,
    LoginRateLimiter,
    IdentityService,
    SessionGuard,
    // Default deny: registered globally, so every current and future controller is protected.
    { provide: APP_GUARD, useExisting: SessionGuard },
  ],
  exports: [AuthorizationService, AuthService],
})
export class AuthModule {}
