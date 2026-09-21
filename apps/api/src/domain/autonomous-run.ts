import { randomUUID } from "node:crypto";
import type { EntityId, IsoTimestamp } from "@affiliateos/shared";

export type AutonomousRunStatus = "accepted" | "processing" | "completed" | "failed";

export interface AutonomousRun {
  id: EntityId;
  idempotencyKey: string;
  opportunityProductId: EntityId;
  offerId: EntityId;
  campaignId?: EntityId;
  status: AutonomousRunStatus;
  lastError?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AutonomousRunRepository {
  findByIdempotencyKey(key: string): Promise<AutonomousRun | undefined>;
  findById?(id: EntityId): Promise<AutonomousRun | undefined>;
  save(run: AutonomousRun): Promise<AutonomousRun>;
  saveIfAbsent?(run: AutonomousRun): Promise<AutonomousRun>;
  transition?(id: EntityId, expected: AutonomousRunStatus[], run: AutonomousRun): Promise<AutonomousRun | undefined>;
  claimProcessing?(id: EntityId, now: Date, staleAfterMs: number): Promise<AutonomousRun | undefined>;
}

export class InMemoryAutonomousRunRepository implements AutonomousRunRepository {
  private readonly runs = new Map<string, AutonomousRun>();

  async findByIdempotencyKey(key: string) {
    return this.runs.get(key);
  }

  async findById(id: EntityId) {
    return [...this.runs.values()].find((run) => run.id === id);
  }

  async save(run: AutonomousRun) {
    this.runs.set(run.idempotencyKey, run);
    return run;
  }

  async saveIfAbsent(run: AutonomousRun) {
    const existing = this.runs.get(run.idempotencyKey);
    if (existing) return existing;
    this.runs.set(run.idempotencyKey, run);
    return run;
  }

  async transition(id: EntityId, expected: AutonomousRunStatus[], run: AutonomousRun) {
    const current = [...this.runs.values()].find((candidate) => candidate.id === id);
    if (!current || !expected.includes(current.status)) return undefined;
    this.runs.set(run.idempotencyKey, run);
    return run;
  }

  async claimProcessing(id: EntityId, now: Date, staleAfterMs: number) {
    const current = [...this.runs.values()].find((candidate) => candidate.id === id);
    if (!current) return undefined;
    const staleCutoff = now.getTime() - staleAfterMs;
    const staleProcessing = current.status === "processing" && new Date(current.updatedAt).getTime() <= staleCutoff;
    if (current.status !== "accepted" && current.status !== "failed" && !staleProcessing) return undefined;
    const claimed: AutonomousRun = {
      ...current,
      status: "processing",
      lastError: undefined,
      updatedAt: now.toISOString()
    };
    this.runs.set(current.idempotencyKey, claimed);
    return claimed;
  }
}

export function createAutonomousRun(input: {
  idempotencyKey: string;
  productId: EntityId;
  offerId: EntityId;
  now?: Date;
}): AutonomousRun {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    idempotencyKey: input.idempotencyKey,
    opportunityProductId: input.productId,
    offerId: input.offerId,
    status: "accepted",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
