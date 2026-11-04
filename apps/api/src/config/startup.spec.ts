import { describe, expect, it } from 'vitest';
import { TEST_ADMIN_ENV } from '../../test/fixtures/admin.js';
import { loadConfig } from './app-config.js';
import { loadConfigOrExit } from './startup.js';

const SENTINEL = 'sentinel-secret-9f3a';

function run(env: Record<string, string | undefined>) {
  const output: string[] = [];
  const exits: number[] = [];
  const io = {
    error: (m: string) => void output.push(m),
    exit: (code: number): never => {
      exits.push(code);
      throw new Error('exit');
    },
  };
  let result: unknown;
  try {
    result = loadConfigOrExit(() => loadConfig(env), io);
  } catch (err) {
    expect((err as Error).message).toBe('exit');
  }
  return { output, exits, result };
}

describe('loadConfigOrExit', () => {
  it('exits with one sanitized line when DATABASE_URL is missing', () => {
    const { output, exits } = run({ ...TEST_ADMIN_ENV });
    expect(exits).toEqual([1]);
    expect(output).toEqual(['Invalid configuration: DATABASE_URL (is required)']);
  });

  it('never prints a malformed DATABASE_URL, its credentials or raw errors', () => {
    const { output, exits } = run({ ...TEST_ADMIN_ENV, DATABASE_URL: `mysql://admin:${SENTINEL}@db.internal:3306/x` });
    expect(exits).toEqual([1]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('DATABASE_URL');
    for (const leaked of [SENTINEL, 'admin', 'db.internal', 'Invalid URL', 'ZodError']) {
      expect(output.join('\n')).not.toContain(leaked);
    }
  });

  it('hides unexpected loader errors that may carry values', () => {
    const output: string[] = [];
    const io = {
      error: (m: string) => void output.push(m),
      exit: (): never => {
        throw new Error('exit');
      },
    };
    expect(() =>
      loadConfigOrExit(() => {
        throw new Error(`boom ${SENTINEL}`);
      }, io),
    ).toThrow('exit');
    expect(output.join('')).not.toContain(SENTINEL);
  });

  it('returns the config and does not exit when valid', () => {
    const { exits, result } = run({ ...TEST_ADMIN_ENV, DATABASE_URL: 'postgres://u:p@localhost/db' });
    expect(exits).toEqual([]);
    expect(result).toMatchObject({ port: 4200 });
  });
});
