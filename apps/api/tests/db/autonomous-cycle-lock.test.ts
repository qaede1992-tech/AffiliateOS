import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAutonomousCycleLock } from "../../src/db/autonomous-cycle-lock.js";

class FakeClient {
  private readonly locks: Set<string>;
  released = false;

  constructor(locks: Set<string>) {
    this.locks = locks;
  }

  async query<T>(sql: string, params: string[]) {
    const key = params[0]!;
    if (sql.includes("pg_try_advisory_lock")) {
      const locked = !this.locks.has(key);
      if (locked) this.locks.add(key);
      return { rows: [{ locked }] } as { rows: T[] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      this.locks.delete(key);
      return { rows: [] } as { rows: T[] };
    }
    throw new Error("Unexpected SQL");
  }

  release() {
    this.released = true;
  }
}

class FakePool {
  readonly locks = new Set<string>();
  clients: FakeClient[] = [];

  async connect() {
    const client = new FakeClient(this.locks);
    this.clients.push(client);
    return client as any;
  }
}

test("Postgres autonomous cycle lock prevents concurrent instances and releases the lock", async () => {
  const pool = new FakePool();
  const first = new PostgresAutonomousCycleLock(pool as any);
  const second = new PostgresAutonomousCycleLock(pool as any);

  assert.equal(await first.tryAcquire("affiliateos:autonomous-cycle"), true);
  assert.equal(await second.tryAcquire("affiliateos:autonomous-cycle"), false);

  await first.release("affiliateos:autonomous-cycle");

  assert.equal(await second.tryAcquire("affiliateos:autonomous-cycle"), true);
  await second.release("affiliateos:autonomous-cycle");

  assert.equal(pool.clients.every((client) => client.released), true);
});
