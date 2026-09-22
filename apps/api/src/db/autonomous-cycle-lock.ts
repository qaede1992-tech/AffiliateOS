import type { Pool, PoolClient } from "pg";
import type { AutonomousCycleLock } from "../domain/autonomous-cycle-lock.js";

/**
 * Uses a PostgreSQL session-level advisory lock so multiple API instances cannot
 * execute the same autonomous cycle concurrently. The checked-out connection is
 * retained until release because advisory locks are scoped to a DB session.
 */
const ADVISORY_LOCK_HASH_SEED = 0;

export class PostgresAutonomousCycleLock implements AutonomousCycleLock {
  private readonly clients = new Map<string, PoolClient>();

  constructor(private readonly pool: Pool) {}

  async tryAcquire(key: string): Promise<boolean> {
    if (this.clients.has(key)) return false;

    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked",
        [key, ADVISORY_LOCK_HASH_SEED]
      );
      if (!result.rows[0]?.locked) {
        client.release();
        return false;
      }
      this.clients.set(key, client);
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async release(key: string): Promise<void> {
    const client = this.clients.get(key);
    if (!client) return;
    this.clients.delete(key);
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, $2))", [key]);
    } finally {
      client.release();
    }
  }
}
