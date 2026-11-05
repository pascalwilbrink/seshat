import { BadRequestException, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ACTIONS, PERMISSIONS } from '@seshat/domain';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyRecord, ApiKeyStore } from '../api-keys/api-key.store.js';
import type { AuthService } from './auth.service.js';
import { SessionGuard } from './session.guard.js';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const KEY = 'sk_seshat_AbCdEfGh_SENTINELsecret0123456789abcdefghijklmnop';
const WS = '11111111-1111-4111-8111-111111111111';

function record(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'k1',
    workspaceId: WS,
    name: 'key one',
    prefix: 'AbCdEfGh',
    permissions: ['files:read'],
    createdAt: new Date(NOW),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

function setup(found: ApiKeyRecord | null, validSession = true) {
  const keys = { findByKey: vi.fn(async () => found), touchLastUsed: vi.fn(async () => true) };
  const auth = { isValidSessionToken: vi.fn(() => validSession) };
  const guard = new SessionGuard(auth as unknown as AuthService, keys as unknown as ApiKeyStore, { now: () => NOW });
  const run = (method: string, path: string, headers: Record<string, string>) => {
    const req: Record<string, unknown> = { method, path, headers };
    const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    return guard.canActivate(ctx).then((ok) => ({ ok, req }));
  };
  return { keys, auth, run };
}

describe('SessionGuard bearer authentication', () => {
  it('resolves a typed api key principal and touches last_used', async () => {
    const { run, keys } = setup(record({ permissions: ['files:read', 'global:read'] }));
    const { req } = await run('GET', '/api/auth/me', { authorization: `Bearer ${KEY}` });
    expect(req.principal).toEqual({ kind: 'apiKey', keyId: 'k1', keyName: 'key one', workspaceId: WS, permissions: ['files:read', 'global:read'] });
    expect(keys.findByKey).toHaveBeenCalledWith(KEY);
    expect(keys.touchLastUsed).toHaveBeenCalledWith('k1');
  });

  it('accepts a lowercase scheme', async () => {
    const { run } = setup(record());
    expect((await run('GET', '/api/auth/me', { authorization: `bearer ${KEY}` })).req.principal).toBeDefined();
  });

  it.each([
    ['unknown/wrong key', null, `Bearer ${KEY}`],
    ['revoked', record({ revokedAt: new Date(NOW - 1) }), `Bearer ${KEY}`],
    ['expired at the boundary', record({ expiresAt: new Date(NOW) }), `Bearer ${KEY}`],
    ['expired earlier', record({ expiresAt: new Date(NOW - 1) }), `Bearer ${KEY}`],
    ['no permissions', record({ permissions: [] }), `Bearer ${KEY}`],
    ['empty token', null, 'Bearer'],
    ['two tokens', null, `Bearer ${KEY} extra`],
    ['oversized', null, `Bearer ${'x'.repeat(400)}`],
  ])('rejects %s with the same generic 401', async (_n, found, header) => {
    const { run, keys } = setup(found);
    const err = await run('GET', '/api/auth/me', { authorization: header }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('Unauthorized');
    expect(JSON.stringify(err.getResponse())).not.toContain('SENTINEL');
    expect(keys.touchLastUsed).not.toHaveBeenCalled();
  });

  it('accepts a key that expires one millisecond in the future', async () => {
    const { run } = setup(record({ expiresAt: new Date(NOW + 1) }));
    expect((await run('GET', '/api/auth/me', { authorization: `Bearer ${KEY}` })).req.principal).toBeDefined();
  });

  it('uses the newest record each request (permission edits and revocation apply at once)', async () => {
    const { run, keys } = setup(record());
    await run('GET', '/x', { authorization: `Bearer ${KEY}` });
    keys.findByKey.mockResolvedValueOnce(record({ permissions: ['files:read', 'search'] }));
    expect((await run('GET', '/x', { authorization: `Bearer ${KEY}` })).req.principal).toMatchObject({
      permissions: ['files:read', 'search'],
    });
    keys.findByKey.mockResolvedValueOnce(record({ revokedAt: new Date(NOW) }));
    await expect(run('GET', '/x', { authorization: `Bearer ${KEY}` })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not fail the request when the last-used write fails', async () => {
    const { run, keys } = setup(record());
    keys.touchLastUsed.mockRejectedValueOnce(new Error('db down'));
    expect((await run('GET', '/x', { authorization: `Bearer ${KEY}` })).req.principal).toBeDefined();
  });

  it.each([
    ['valid cookie', 'seshat_session=abc'],
    ['invalid cookie', 'seshat_session=garbage'],
    ['empty cookie', 'seshat_session='],
    ['among others', 'a=1; seshat_session=x; b=2'],
    ['duplicated cookie', 'seshat_session=a; seshat_session=b'],
  ])('rejects cookie + bearer with 400 (%s), without looking up the key', async (_n, cookie) => {
    const { run, keys } = setup(record(), false);
    for (const [method, path] of [['GET', '/api/auth/me'], ['POST', '/api/auth/login'], ['GET', '/api/health']] as const) {
      const err = await run(method, path, { authorization: `Bearer ${KEY}`, cookie }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err.getResponse())).not.toContain('SENTINEL');
    }
    expect(keys.findByKey).not.toHaveBeenCalled();
  });

  it('keeps admin sessions and ignores unrelated cookies and non-bearer authorization', async () => {
    const { run, keys } = setup(null);
    expect((await run('GET', '/x', { cookie: 'seshat_session=ok' })).req.principal).toEqual({ kind: 'admin' });
    await expect(run('GET', '/x', { cookie: 'other=1', authorization: `Basic ${KEY}` })).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await run('GET', '/x', { cookie: 'seshat_session=ok', authorization: 'Basic abc' })).req.principal).toEqual({ kind: 'admin' });
    expect(keys.findByKey).not.toHaveBeenCalled();
  });

  it('leaves public routes public (bearer is not evaluated there)', async () => {
    const { run, keys } = setup(null);
    expect((await run('GET', '/api/health', { authorization: `Bearer ${KEY}` })).ok).toBe(true);
    expect(keys.findByKey).not.toHaveBeenCalled();
  });

  it('does not make auth/me public', async () => {
    const { run } = setup(null);
    await expect(run('GET', '/api/auth/me', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('single catalog', () => {
  it('the guard source has no permission or action lists of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./session.guard.ts', import.meta.url), 'utf8');
    for (const p of [...PERMISSIONS, ...ACTIONS]) expect(src).not.toContain(`'${p}'`);
  });
});
