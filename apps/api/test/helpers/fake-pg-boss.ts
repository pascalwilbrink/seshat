import { EventEmitter } from 'node:events';

/** In-memory stand-in for pg-boss, for tests that boot AppModule without a real queue database. */
export class FakePgBoss extends EventEmitter {
  async start() { return this; }
  async stop() {}
  async createQueue() {}
  async updateQueue() {}
  async send() { return 'job-id'; }
  async work() { return 'worker-id'; }
  async offWork() {}
  async schedule() {}
}

export const fakePgBossModule = () => ({ PgBoss: FakePgBoss });
