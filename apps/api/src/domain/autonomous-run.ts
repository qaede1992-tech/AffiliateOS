import { randomUUID } from "node:crypto";
import type { AudienceSegment, ContentPlatform, EntityId, IsoTimestamp } from "@affiliateos/shared";

export type AutonomousRunStatus = "accepted" | "processing" | "completed" | "failed";
export interface AutonomousRunExecutionContext { audience: AudienceSegment[]; platforms: ContentPlatform[]; scheduledAt?: IsoTimestamp; }
export interface AutonomousRun {
  id: EntityId; idempotencyKey: string; opportunityProductId: EntityId; offerId: EntityId; campaignId?: EntityId;
  status: AutonomousRunStatus; attemptCount: number; nextAttemptAt?: IsoTimestamp; lastError?: string;
  executionContext?: AutonomousRunExecutionContext; createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
}
export interface AutonomousRunRepository {
  findByIdempotencyKey(key: string): Promise<AutonomousRun | undefined>;
  findById?(id: EntityId): Promise<AutonomousRun | undefined>;
  save(run: AutonomousRun): Promise<AutonomousRun>;
  saveIfAbsent?(run: AutonomousRun): Promise<AutonomousRun>;
  transition?(id: EntityId, expected: AutonomousRunStatus[], run: AutonomousRun): Promise<AutonomousRun | undefined>;
  claimProcessing?(id: EntityId, now: Date, staleAfterMs: number, maxAttempts: number): Promise<AutonomousRun | undefined>;
  list?(options?: { status?: AutonomousRunStatus; limit?: number }): Promise<AutonomousRun[]>;
  listRecoverable?(staleBefore: Date, now?: Date, limit?: number, maxAttempts?: number): Promise<AutonomousRun[]>;
}
export class InMemoryAutonomousRunRepository implements AutonomousRunRepository {
  private readonly runs = new Map<string, AutonomousRun>();
  async findByIdempotencyKey(key: string) { return this.runs.get(key); }
  async findById(id: EntityId) { return [...this.runs.values()].find((run) => run.id === id); }
  async save(run: AutonomousRun) { this.runs.set(run.idempotencyKey, run); return run; }
  async saveIfAbsent(run: AutonomousRun) { const existing = this.runs.get(run.idempotencyKey); if (existing) return existing; this.runs.set(run.idempotencyKey, run); return run; }
  async transition(id: EntityId, expected: AutonomousRunStatus[], run: AutonomousRun) {
    const current = [...this.runs.values()].find((candidate) => candidate.id === id);
    if (!current || !expected.includes(current.status)) return undefined;
    const next: AutonomousRun = {
      ...current,
      status: run.status,
      campaignId: run.campaignId,
      executionContext: run.executionContext,
      attemptCount: run.attemptCount,
      nextAttemptAt: run.nextAttemptAt,
      lastError: run.lastError,
      updatedAt: run.updatedAt
    };
    this.runs.set(current.idempotencyKey, next);
    return next;
  }
  async list(options: { status?: AutonomousRunStatus; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
    return [...this.runs.values()]
      .filter((run) => !options.status || run.status === options.status)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  }
  async listRecoverable(staleBefore: Date, now = new Date(), limit = 100, maxAttempts = 8) {
    return [...this.runs.values()].filter((run) => {
      if (run.attemptCount >= maxAttempts) return false;
      if (run.status === "accepted") return true;
      if (run.status === "failed") return !run.nextAttemptAt || new Date(run.nextAttemptAt).getTime() <= now.getTime();
      return run.status === "processing" && new Date(run.updatedAt).getTime() <= staleBefore.getTime();
    }).sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()).slice(0, Math.max(1, limit));
  }
  async claimProcessing(id: EntityId, now: Date, staleAfterMs: number, maxAttempts = 8) {
    const current = [...this.runs.values()].find((candidate) => candidate.id === id);
    if (!current || current.attemptCount >= maxAttempts) return undefined;
    const staleCutoff = now.getTime() - staleAfterMs;
    const staleProcessing = current.status === "processing" && new Date(current.updatedAt).getTime() <= staleCutoff;
    const failedDue = current.status === "failed" && (!current.nextAttemptAt || new Date(current.nextAttemptAt).getTime() <= now.getTime());
    if (current.status !== "accepted" && !failedDue && !staleProcessing) return undefined;
    const claimed: AutonomousRun = { ...current, status: "processing", attemptCount: current.attemptCount + 1, nextAttemptAt: undefined, lastError: undefined, updatedAt: now.toISOString() };
    this.runs.set(current.idempotencyKey, claimed); return claimed;
  }
}
export function createAutonomousRun(input: { idempotencyKey: string; productId: EntityId; offerId: EntityId; executionContext?: AutonomousRunExecutionContext; now?: Date }): AutonomousRun {
  const timestamp = (input.now ?? new Date()).toISOString();
  return { id: randomUUID(), idempotencyKey: input.idempotencyKey, opportunityProductId: input.productId, offerId: input.offerId, status: "accepted", attemptCount: 0, executionContext: input.executionContext, createdAt: timestamp, updatedAt: timestamp };
}
