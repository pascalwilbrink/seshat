import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { WorkspacesService } from './workspace.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { Workspace } from './workspace.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace]), forwardRef(() => AuthModule)],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
