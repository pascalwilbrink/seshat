import { Inject, Injectable } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

export type HealthReport =
  | { status: 'ok'; db: 'ok' }
  | { status: 'error'; db: 'unreachable' };

const CHECK_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  constructor(@Inject(getDataSourceToken()) private readonly dataSource: Pick<DataSource, 'query'>) {}

  /**
   * Runs one cheap query. Any failure (or a timeout) maps to the fixed "unreachable" report: the underlying
   * error is deliberately neither returned nor logged, since driver errors can carry connection details.
   */
  async check(): Promise<HealthReport> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.dataSource.query('SELECT 1'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return { status: 'ok', db: 'ok' };
    } catch {
      return { status: 'error', db: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
