export interface AutonomousCycleLockRepository {
  tryAcquire(lockKey: string, ownerId: string, now: string, leaseUntil: string): Promise<boolean>;
  renew(lockKey: string, ownerId: string, now: string, leaseUntil: string): Promise<boolean>;
  release(lockKey: string, ownerId: string): Promise<void>;
}

export class InMemoryAutonomousCycleLockRepository implements AutonomousCycleLockRepository {
  private readonly locks = new Map<string, { ownerId: string; leaseUntil: string }>();

  async tryAcquire(lockKey: string, ownerId: string, now: string, leaseUntil: string): Promise<boolean> {
    const current = this.locks.get(lockKey);
    if (current && current.leaseUntil > now && current.ownerId !== ownerId) return false;
    this.locks.set(lockKey, { ownerId, leaseUntil });
    return true;
  }

  async renew(lockKey: string, ownerId: string, now: string, leaseUntil: string): Promise<boolean> {
    const current = this.locks.get(lockKey);
    if (!current || current.ownerId !== ownerId || current.leaseUntil <= now) return false;
    this.locks.set(lockKey, { ownerId, leaseUntil });
    return true;
  }

  async release(lockKey: string, ownerId: string): Promise<void> {
    if (this.locks.get(lockKey)?.ownerId === ownerId) this.locks.delete(lockKey);
  }
}
