import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthorizationService } from '../auth/authorization.service.js';
import { ADMIN_PRINCIPAL } from '../auth/principal.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';
import { InMemoryWorkspaces } from '../../test/helpers/workspace-app.js';
import { createWorkspaceSchema, updateWorkspaceSchema } from './workspace.dto.js';
import { WorkspacesService, deriveSlug } from './workspace.service.js';

function setup(authorization = new AuthorizationService()) {
  const mem = new InMemoryWorkspaces();
  const events = new EventEmitter2();
  const emitted: unknown[] = [];
  events.on('workspace.deleted', (e) => emitted.push(e));
  const service = new WorkspacesService(mem.repo as never, mem.dataSource as never, authorization, events);
  return { mem, service, emitted };
}

describe('deriveSlug', () => {
  it.each([
    ['My Workspace', 'my-workspace'],
    ['  --Hi__there!! ', 'hi-there'],
    ['Café', 'cafe'],
    ['!!!', ''],
    ['a'.repeat(150), 'a'.repeat(100)],
  ])('%j -> %j', (input, out) => expect(deriveSlug(input)).toBe(out));
});

describe('WorkspacesService with explicit principal and scope', () => {
  it('creates, reads, updates (slug fixed) and deletes', async () => {
    const { service, emitted } = setup();
    const created = await service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'Aether' });
    expect(created.slug).toBe('aether');
    const scope = workspaceScope(created.id);
    expect((await service.get(ADMIN_PRINCIPAL, scope)).name).toBe('Aether');
    const updated = await service.update(ADMIN_PRINCIPAL, scope, { name: 'Aether 2' });
    expect(updated).toMatchObject({ name: 'Aether 2', slug: 'aether' });
    await expect(service.remove(ADMIN_PRINCIPAL, scope, 'wrong')).rejects.toBeInstanceOf(BadRequestException);
    expect(emitted).toEqual([]);
    await service.remove(ADMIN_PRINCIPAL, scope, 'aether');
    expect(emitted).toEqual([{ id: created.id }]);
    await expect(service.get(ADMIN_PRINCIPAL, scope)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects slug collisions with ConflictException and an unusable derived slug with 400', async () => {
    const { service } = setup();
    await service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'One' });
    await expect(service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'x', slug: 'one' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create(ADMIN_PRINCIPAL, globalScope(), { name: '???' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'Global' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not use an implicit scope: wrong scope kind is a programming error', async () => {
    const { service } = setup();
    await expect(service.list(ADMIN_PRINCIPAL, workspaceScope('3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'))).rejects.toThrow();
    await expect(service.get(ADMIN_PRINCIPAL, globalScope())).rejects.toThrow();
  });

  it('asks AuthorizationService before touching data', async () => {
    const calls: string[] = [];
    const spy = new AuthorizationService();
    const orig = spy.assertCan.bind(spy);
    spy.assertCan = (p, a, s) => {
      calls.push(`${a}:${s.kind}`);
      return orig(p, a, s);
    };
    const { service, mem } = setup(spy);
    await service.list(ADMIN_PRINCIPAL, globalScope());
    const w = await service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'A' });
    const scope = workspaceScope(w.id);
    await service.get(ADMIN_PRINCIPAL, scope);
    await service.update(ADMIN_PRINCIPAL, scope, { name: 'B' });
    await service.remove(ADMIN_PRINCIPAL, scope, 'a');
    expect(calls).toEqual([
      'workspace:list:global',
      'workspace:create:global',
      'workspace:read:workspace',
      'workspace:update:workspace',
      'workspace:delete:workspace',
    ]);
    expect(mem.rows).toEqual([]);
  });

  it('still succeeds when a listener throws after commit', async () => {
    const mem = new InMemoryWorkspaces();
    const events = new EventEmitter2();
    events.on('workspace.deleted', () => {
      throw new Error('listener SENTINEL');
    });
    const service = new WorkspacesService(mem.repo as never, mem.dataSource as never, new AuthorizationService(), events);
    const w = await service.create(ADMIN_PRINCIPAL, globalScope(), { name: 'A' });
    await expect(service.remove(ADMIN_PRINCIPAL, workspaceScope(w.id), 'a')).resolves.toBeUndefined();
    expect(mem.rows).toHaveLength(0);
  });
});

describe('workspace DTO schemas', () => {
  it('trims names, nulls blank descriptions, rejects unknown keys', () => {
    expect(createWorkspaceSchema.parse({ name: ' A ', description: '  ' })).toEqual({ name: 'A', description: null });
    expect(createWorkspaceSchema.safeParse({ name: 'A', slug: 'global' }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: 'A', x: 1 }).success).toBe(false);
    expect(updateWorkspaceSchema.safeParse({ slug: 'a' }).success).toBe(false);
    expect(updateWorkspaceSchema.safeParse({}).success).toBe(false);
  });
});
