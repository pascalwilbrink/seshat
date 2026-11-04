import { afterEach, describe, expect, it, vi } from 'vitest';
import { DenyingAuthorization, InMemoryWorkspaces, type WorkspaceApp, bootWorkspaceApp } from './helpers/workspace-app.js';
import { defineWorkspaceHttpSuite } from './helpers/workspace-http-suite.js';

describe('Workspace + Overview HTTP boundary (in-memory repository)', () => {
  let app: WorkspaceApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  defineWorkspaceHttpSuite({
    async boot(opts) {
      const mem = new InMemoryWorkspaces();
      app = await bootWorkspaceApp({ repo: mem.repo, dataSource: mem.dataSource, authorization: opts?.authorization });
      return { app, failDelete: (e) => void (mem.failNextDelete = e), countRows: async () => mem.rows.length };
    },
  });

  it('is wired to the injected policy only (sanity)', () => {
    expect(new DenyingAuthorization('all').can({ kind: 'admin' }, 'overview:read', { kind: 'global' })).toBe(false);
  });
});
