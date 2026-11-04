import { describe, expect, it } from 'vitest';
import { InvalidScopeError, globalScope, parseScopeRef, scopeColumns, workspaceScope } from './scope-ref.js';

const ID = '3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('parseScopeRef', () => {
  it('parses explicit global', () => {
    expect(parseScopeRef({ scope: 'global' })).toEqual({ kind: 'global' });
    expect(parseScopeRef({ scope: 'global', workspaceId: null })).toEqual({ kind: 'global' });
  });
  it('parses a workspace UUID, lowercasing it', () => {
    expect(parseScopeRef({ scope: 'workspace', workspaceId: ID.toUpperCase() })).toEqual({
      kind: 'workspace',
      workspaceId: ID,
    });
  });
  it.each([
    ['empty object', {}],
    ['null', null],
    ['array', []],
    ['string', 'global'],
    ['unknown scope', { scope: 'team' }],
    ['global with workspaceId', { scope: 'global', workspaceId: ID }],
    ['workspace without id', { scope: 'workspace' }],
    ['workspace with null id', { scope: 'workspace', workspaceId: null }],
    ['workspace with non-uuid', { scope: 'workspace', workspaceId: 'abc' }],
    ['workspace with slug', { scope: 'workspace', workspaceId: 'global' }],
    ['uuid with suffix', { scope: 'workspace', workspaceId: `${ID}x` }],
    ['uuid with whitespace', { scope: 'workspace', workspaceId: ` ${ID}` }],
    ['uuid as number', { scope: 'workspace', workspaceId: 1 }],
    ['extra key', { scope: 'global', other: 1 }],
    ['wrong case scope', { scope: 'Global' }],
  ])('rejects %s', (_n, input) => {
    expect(() => parseScopeRef(input)).toThrow(InvalidScopeError);
  });
});

describe('workspaceScope / scopeColumns', () => {
  it('rejects invalid UUIDs', () => {
    expect(() => workspaceScope('nope')).toThrow(InvalidScopeError);
    expect(() => workspaceScope(undefined)).toThrow(InvalidScopeError);
  });
  it('maps to columns with null workspace_id only for global', () => {
    expect(scopeColumns(globalScope())).toEqual({ scope: 'global', workspaceId: null });
    expect(scopeColumns(workspaceScope(ID))).toEqual({ scope: 'workspace', workspaceId: ID });
  });
});
