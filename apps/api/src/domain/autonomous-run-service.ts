import { createAutonomousRun, type AutonomousRun, type AutonomousRunRepository, type AutonomousRunStatus } from "./autonomous-run.js";
import type { EntityId } from "@affiliateos/shared";

const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

const allowedTransitions: Record<AutonomousRunStatus, AutonomousRunStatus[]> = {
  accepted: ["accepted", "processing", "failed"],
  processing: ["processing", "completed", "failed"],
  completed: ["completed"],
  failed: ["failed", "processing"]
};

export type AutonomousRunClaim = {
  run: AutonomousRun;
  acquired: boolean;
};

export class AutonomousRunService {
  constructor(private readonly runs: AutonomousRunRepository) {}

  async accept(input: { idempotencyKey: string; productId: EntityId; offerId: EntityId; now?: Date }): Promise<AutonomousRun> {
    const existing = await this.runs.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const run = createAutonomousRun(input);
    if (this.runs.saveIfAbsent) return this.runs.saveIfAbsent(run);
    try {
      return await this.runs.save(run);
    } catch (error) {
      const concurrent = await this.runs.findByIdempotencyKey(input.idempotencyKey);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async claimProcessing(id: EntityId, now = new Date(), processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS): Promise<AutonomousRunClaim> {
    const run = this.runs.findById ? await this.runs.findById(id) : undefined;
    if (!run) throw new Error("Autonomous run does not exist.");
    if (run.status === "processing") {
      const timeoutMs = Math.max(1, processingTimeoutMs);
      const updatedAt = new Date(run.updatedAt).getTime();
      const staleBeforeMs = now.getTime() - timeoutMs;
      if (Number.isFinite(updatedAt) && updatedAt <= staleBeforeMs && this.runs.claimStaleProcessing) {
        const next: AutonomousRun = {
          ...run,
          status: "processing",
          lastError: undefined,
          updatedAt: now.toISOString()
        };
        const recovered = await this.runs.claimStaleProcessing(id, new Date(staleBeforeMs).toISOString(), next);
        if (recovered) return { run: recovered, acquired: true };
        const current = this.runs.findById ? await this.runs.findById(id) : undefined;
        return { run: current ?? run, acquired: false };
      }
      return { run, acquired: false };
    }

    if (run.status !== "accepted" && run.status !== "failed") return { run, acquired: false };

    const next: AutonomousRun = {
      ...run,
      status: "processing",
      lastError: undefined,
      updatedAt: now.toISOString()
    };
    if (this.runs.transition) {
      const transitioned = await this.runs.transition(id, [run.status], next);
      if (transitioned) return { run: transitioned, acquired: true };
      const current = this.runs.findById ? await this.runs.findById(id) : undefined;
      return { run: current ?? run, acquired: false };
    }
    return { run: await this.runs.save(next), acquired: true };
  }

  async transition(id: EntityId, status: AutonomousRunStatus, details: { campaignId?: EntityId; error?: string } = {}, now = new Date()): Promise<AutonomousRun> {
    const run = this.runs.findById ? await this.runs.findById(id) : undefined;
    if (!run) throw new Error("Autonomous run does not exist.");
    if (!allowedTransitions[run.status].includes(status)) return run;
    const next: AutonomousRun = {
      ...run,
      status,
      campaignId: details.campaignId ?? run.campaignId,
      lastError: details.error,
      updatedAt: now.toISOString()
    };
    if (this.runs.transition) {
      const transitioned = await this.runs.transition(id, [run.status], next);
      return transitioned ?? (this.runs.findById ? (await this.runs.findById(id)) ?? run : run);
    }
    return this.runs.save(next);
  }
}
