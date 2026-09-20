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
  save(run: AutonomousRun): Promise<AutonomousRun>;
  saveIfAbsent?(run: AutonomousRun): Promise<AutonomousRun>;
}

export class InMemoryAutonomousRunRepository implements AutonomousRunRepository {
  private readonly runs = new Map<string, AutonomousRun>();

  async findByIdempotencyKey(key: string) {
    return this.runs.get(key);
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
