import { createAutonomousRun, type AutonomousRun, type AutonomousRunRepository, type AutonomousRunStatus } from "./autonomous-run.js";
import type { EntityId } from "@affiliateos/shared";

const AUTONOMOUS_RUN_PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000;
const AUTONOMOUS_RUN_RECOVERY_LIMIT = 100;
const AUTONOMOUS_RUN_MAX_ATTEMPTS = 8;
const AUTONOMOUS_RUN_RETRY_INITIAL_DELAY_MS = 60 * 1000;
const AUTONOMOUS_RUN_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
const allowedTransitions: Record<AutonomousRunStatus, AutonomousRunStatus[]> = {
  accepted: ["accepted", "processing", "failed"], processing: ["processing", "completed", "failed"],
  completed: ["completed"], failed: ["failed", "processing"]
};
const retryDelayMs = (attemptCount: number) => Math.min(AUTONOMOUS_RUN_RETRY_MAX_DELAY_MS, AUTONOMOUS_RUN_RETRY_INITIAL_DELAY_MS * 2 ** Math.max(0, attemptCount - 1));

export class AutonomousRunService {
  constructor(private readonly runs: AutonomousRunRepository) {}
  async accept(input: { idempotencyKey: string; productId: EntityId; offerId: EntityId; now?: Date }): Promise<AutonomousRun> {
    const existing = await this.runs.findByIdempotencyKey(input.idempotencyKey); if (existing) return existing;
    const run = createAutonomousRun(input);
    if (this.runs.saveIfAbsent) return this.runs.saveIfAbsent(run);
    try { return await this.runs.save(run); } catch (error) {
      const concurrent = await this.runs.findByIdempotencyKey(input.idempotencyKey); if (concurrent) return concurrent; throw error;
    }
  }
  async listRecoverable(now = new Date(), limit = AUTONOMOUS_RUN_RECOVERY_LIMIT) {
    if (!this.runs.listRecoverable) return [];
    const staleBefore = new Date(now.getTime() - AUTONOMOUS_RUN_PROCESSING_STALE_AFTER_MS);
    return this.runs.listRecoverable(staleBefore, now, limit, AUTONOMOUS_RUN_MAX_ATTEMPTS);
  }
  async claimProcessing(id: EntityId, now = new Date()): Promise<{ run: AutonomousRun; acquired: boolean }> {
    const run = this.runs.findById ? await this.runs.findById(id) : undefined;
    if (!run) throw new Error("Autonomous run does not exist.");
    if (run.attemptCount >= AUTONOMOUS_RUN_MAX_ATTEMPTS) return { run, acquired: false };
    if (run.status === "processing" && this.runs.claimProcessing) {
      const reclaimed = await this.runs.claimProcessing(id, now, AUTONOMOUS_RUN_PROCESSING_STALE_AFTER_MS, AUTONOMOUS_RUN_MAX_ATTEMPTS);
      if (reclaimed) return { run: reclaimed, acquired: true };
      const current = this.runs.findById ? await this.runs.findById(id) : undefined; return { run: current ?? run, acquired: false };
    }
    if (run.status !== "accepted" && run.status !== "failed") return { run, acquired: false };
    if (run.status === "failed" && run.nextAttemptAt && new Date(run.nextAttemptAt).getTime() > now.getTime()) return { run, acquired: false };
    const next: AutonomousRun = { ...run, status: "processing", attemptCount: run.attemptCount + 1, nextAttemptAt: undefined, lastError: undefined, updatedAt: now.toISOString() };
    if (this.runs.transition) {
      const transitioned = await this.runs.transition(id, [run.status], next);
      if (transitioned) return { run: transitioned, acquired: true };
      const current = this.runs.findById ? await this.runs.findById(id) : undefined; return { run: current ?? run, acquired: false };
    }
    return { run: await this.runs.save(next), acquired: true };
  }
  async transition(id: EntityId, status: AutonomousRunStatus, details: { campaignId?: EntityId; error?: string } = {}, now = new Date()) {
    const run = this.runs.findById ? await this.runs.findById(id) : undefined;
    if (!run) throw new Error("Autonomous run does not exist.");
    if (!allowedTransitions[run.status].includes(status)) return run;
    const failed = status === "failed";
    const startingAttempt = status === "processing" && run.status !== "processing";
    const nextAttemptCount = startingAttempt ? run.attemptCount + 1 : run.attemptCount;
    const exhausted = nextAttemptCount >= AUTONOMOUS_RUN_MAX_ATTEMPTS;
    const nextAttemptAt = failed && !exhausted ? new Date(now.getTime() + retryDelayMs(Math.max(1, nextAttemptCount))).toISOString() : undefined;
    const next: AutonomousRun = { ...run, status, campaignId: details.campaignId ?? run.campaignId, lastError: details.error, nextAttemptAt, updatedAt: now.toISOString() };
    if (this.runs.transition) {
      const transitioned = await this.runs.transition(id, [run.status], next);
      return transitioned ?? (this.runs.findById ? (await this.runs.findById(id)) ?? run : run);
    }
    return this.runs.save(next);
  }
}
export const autonomousRunRecoveryPolicy = {
  maxAttempts: AUTONOMOUS_RUN_MAX_ATTEMPTS, initialRetryDelayMs: AUTONOMOUS_RUN_RETRY_INITIAL_DELAY_MS,
  maxRetryDelayMs: AUTONOMOUS_RUN_RETRY_MAX_DELAY_MS, processingStaleAfterMs: AUTONOMOUS_RUN_PROCESSING_STALE_AFTER_MS
};
