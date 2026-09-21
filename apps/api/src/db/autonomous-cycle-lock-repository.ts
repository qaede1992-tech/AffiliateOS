import { and, eq, lte, or } from "drizzle-orm";
import type { AutonomousCycleLockRepository } from "../domain/autonomous-cycle-lock.js";
import { autonomousCycleLocks } from "./schema.js";

type DatabaseExecutor = any;

export class DrizzleAutonomousCycleLockRepository implements AutonomousCycleLockRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async tryAcquire(lockKey: string, ownerId: string, now: string, leaseUntil: string): Promise<boolean> {
    const rows = await this.db.update(autonomousCycleLocks)
      .set({ ownerId, leaseUntil, updatedAt: now })
      .where(and(eq(autonomousCycleLocks.lockKey, lockKey), or(eq(autonomousCycleLocks.ownerId, ownerId), lte(autonomousCycleLocks.leaseUntil, now))))
      .returning({ lockKey: autonomousCycleLocks.lockKey });
    if (rows.length > 0) return true;

    const inserted = await this.db.insert(autonomousCycleLocks)
      .values({ lockKey, ownerId, leaseUntil, updatedAt: now })
      .onConflictDoNothing({ target: autonomousCycleLocks.lockKey })
      .returning({ lockKey: autonomousCycleLocks.lockKey });
    return inserted.length > 0;
  }

  async release(lockKey: string, ownerId: string): Promise<void> {
    await this.db.delete(autonomousCycleLocks)
      .where(and(eq(autonomousCycleLocks.lockKey, lockKey), eq(autonomousCycleLocks.ownerId, ownerId)));
  }
}
