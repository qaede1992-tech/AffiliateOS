export interface AutonomousCycleLock {
  tryAcquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export class InMemoryAutonomousCycleLock implements AutonomousCycleLock {
  private readonly held = new Set<string>();

  async tryAcquire(key: string): Promise<boolean> {
    if (this.held.has(key)) return false;
    this.held.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.held.delete(key);
  }
}
