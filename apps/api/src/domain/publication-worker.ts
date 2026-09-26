import type { EntityId } from "@affiliateos/shared";
import { ContentService } from "./content.js";
import { PublisherExecutor } from "./publisher-executor.js";
import type { PublicationJob } from "./publication-job.js";
import { PublicationJobService } from "./publication-job-service.js";
import type { PublicationJobRepository } from "./publication-job.js";
import { PublicationOperationService } from "./publication-operation-service.js";
import type { PublicationOperationRepository } from "./publication-operation.js";

const ACCEPTED_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const PROCESSING_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const RECONCILIATION_BATCH_LIMIT = 100;
const PUBLICATION_JOB_BATCH_LIMIT = 100;
export const PUBLICATION_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

import { publicationRetryDelayMs } from "./publication-job.js";
export { publicationRetryDelayMs } from "./publication-job.js";
const retryEligibleAt = (job: PublicationJob): number =>
  new Date(job.updatedAt).getTime() + publicationRetryDelayMs(job.attemptCount);

const isDue = (job: PublicationJob, now: Date): boolean =>
  new Date(job.scheduledAt).getTime() <= now.getTime();

const isStaleProcessingJob = (job: PublicationJob, now: Date): boolean => {
  if (job.status !== "processing" || !job.lockedAt) return false;
  const lockedAt = new Date(job.lockedAt).getTime();
  return Number.isFinite(lockedAt) && now.getTime() - lockedAt >= PUBLICATION_JOB_LOCK_TIMEOUT_MS;
};

const reconciliationEligibleAt = (operation: import("./publication-operation.js").PublicationOperation): number => {
  const updatedAt = new Date(operation.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return 0;
  const delay = operation.status === "accepted" ? ACCEPTED_RECONCILIATION_DELAY_MS : PROCESSING_RECONCILIATION_DELAY_MS;
  return updatedAt + delay;
};

export type PublicationWorkerResult = {
  jobId: EntityId;
  contentId: EntityId;
  status: "succeeded" | "failed" | "awaiting_confirmation" | "processing" | "skipped";
  externalPostId?: string;
  error?: string;
};

export class PublicationWorker {
  private readonly operations: PublicationOperationService;

  constructor(
    private readonly jobs: PublicationJobRepository,
    private readonly jobService: PublicationJobService,
    private readonly executor: PublisherExecutor,
    private readonly contentService?: ContentService,
    operationRepository?: PublicationOperationRepository
  ) {
    this.operations = new PublicationOperationService(operationRepository ?? new InMemoryFallbackPublicationOperationRepository());
  }

  async runOnce(now = new Date()): Promise<PublicationWorkerResult[]> {
    const results = await this.reconcile(now);
    const candidates = this.jobs.listClaimable
      ? await this.jobs.listClaimable(now, PUBLICATION_JOB_LOCK_TIMEOUT_MS, PUBLICATION_JOB_BATCH_LIMIT)
      : (await this.jobs.list())
          .filter((job) => {
            if (!isDue(job, now)) return false;
            if (job.status === "pending") return true;
            if (job.status === "failed") return retryEligibleAt(job) <= now.getTime();
            return isStaleProcessingJob(job, now);
          })
          .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
          .slice(0, PUBLICATION_JOB_BATCH_LIMIT);

    for (const candidate of candidates) {
      const claimed = await this.jobService.claim(candidate.id, now);
      if (!claimed) continue;
      results.push(await this.process(claimed, now));
    }
    return results;
  }

  private async reconcile(now: Date): Promise<PublicationWorkerResult[]> {
    const results: PublicationWorkerResult[] = [];
    const updatedBefore = new Date(now.getTime() - ACCEPTED_RECONCILIATION_DELAY_MS);
    const operations = await this.operations.listReconciliationCandidates(updatedBefore, RECONCILIATION_BATCH_LIMIT);
    for (const operation of operations) {
      if (operation.status !== "accepted" && operation.status !== "processing") continue;
      if (reconciliationEligibleAt(operation) > now.getTime()) continue;
      try {
        const checked = await this.executor.check(operation);
        const transitionTo = checked.result.status === "processing"
          ? { status: "processing" as const }
          : checked.result.status === "published"
            ? { status: "published" as const, externalPostId: checked.result.externalPostId }
            : { status: "failed" as const, error: checked.result.error };
        const transitioned = await this.operations.transition(operation.id, transitionTo.status, {
          externalPostId: transitionTo.status === "published" ? transitionTo.externalPostId : undefined,
          error: transitionTo.status === "failed" ? transitionTo.error : undefined
        }, now);

        if (!transitioned) {
          results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "skipped" });
          continue;
        }
        const effectiveStatus = transitioned.status;
        if (effectiveStatus === "published" && transitioned.externalPostId) {
          await this.contentService?.update(operation.contentId, { status: "published", publishedAt: now.toISOString() });
          await this.jobService.succeed(operation.jobId, transitioned.externalPostId, now);
          results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "succeeded", externalPostId: transitioned.externalPostId });
          continue;
        }
        if (effectiveStatus === "failed") {
          const error = transitioned.lastError ?? "Publication failed.";
          await this.contentService?.update(operation.contentId, { status: "failed" });
          await this.jobService.fail(operation.jobId, error, now);
          results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "failed", error });
          continue;
        }
        results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "processing" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminalPublicationErrors = new Set([
          "PRODUCT_NOT_ACTIVE",
          "PRODUCT_NOT_FOUND",
          "CONTENT_NOT_FOUND",
          "SOCIAL_ACCOUNT_NOT_FOUND"
        ]);
        const isTerminal = (error: unknown): boolean => {
          if (!error || typeof error !== "object" || !("code" in error)) return false;
          const code = (error as { code?: unknown }).code;
          return typeof code === "string" && terminalPublicationErrors.has(code);
        };
        if (message.includes("does not support publication status checks") || isTerminal(error)) {
          const transitioned = await this.operations.transition(operation.id, "failed", { error: message }, now);
          if (transitioned.status !== "failed") {
            results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "skipped" });
            continue;
          }
          await this.contentService?.update(operation.contentId, { status: "failed" }).catch(() => undefined);
          await this.jobService.fail(operation.jobId, message, now);
          results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "failed", error: message });
          continue;
        }
        await this.operations.transition(operation.id, "processing", { error: message }, now);
        results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "processing", error: message });
      }
    }
    return results;
  }

  private async process(job: PublicationJob, now: Date): Promise<PublicationWorkerResult> {
    try {
      await this.prepareRetry(job);
      const result = await this.executor.execute(job.contentId, now, job.idempotencyKey);
      if (result.status === "published" && result.externalPostId) {
        await this.jobService.succeed(job.id, result.externalPostId, now);
        return { jobId: job.id, contentId: job.contentId, status: "succeeded", externalPostId: result.externalPostId };
      }

      if (result.status === "accepted" && result.providerOperationId) {
        const operation = await this.operations.create({
          contentId: job.contentId,
          jobId: job.id,
          provider: result.provider ?? result.content.platform,
          providerOperationId: result.providerOperationId
        }, now);
        if (operation.status === "published" && operation.externalPostId) {
          await this.contentService?.update(job.contentId, { status: "published", publishedAt: now.toISOString() });
          await this.jobService.succeed(job.id, operation.externalPostId, now);
          return { jobId: job.id, contentId: job.contentId, status: "succeeded", externalPostId: operation.externalPostId };
        }
        if (operation.status === "failed") {
          const error = operation.lastError ?? "Publication operation failed.";
          await this.contentService?.update(job.contentId, { status: "failed" });
          await this.jobService.fail(job.id, error, now);
          return { jobId: job.id, contentId: job.contentId, status: "failed", error };
        }
        await this.jobService.awaitConfirmation(job.id, now);
        return { jobId: job.id, contentId: job.contentId, status: "awaiting_confirmation" };
      }

      if (result.status === "unsupported") {
        const error = `No publisher adapter supports ${result.content.platform}.`;
        await this.jobService.fail(job.id, error, now);
        return { jobId: job.id, contentId: job.contentId, status: "failed", error };
      }

      const error = `Publication was not completed (status: ${result.status}).`;
      await this.jobService.fail(job.id, error, now);
      return { jobId: job.id, contentId: job.contentId, status: "failed", error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobService.fail(job.id, error, now);
      return { jobId: job.id, contentId: job.contentId, status: "failed", error: message };
    }
  }

  private async prepareRetry(job: PublicationJob): Promise<void> {
    if (job.attemptCount <= 1 || !this.contentService) return;
    const content = await this.contentService.get(job.contentId);
    if (content.status !== "failed") return;
    await this.contentService.update(content.id, { status: "scheduled" });
  }
}

class InMemoryFallbackPublicationOperationRepository implements PublicationOperationRepository {
  private readonly operations = new Map<string, import("./publication-operation.js").PublicationOperation>();
  async list() { return [...this.operations.values()]; }
  async findById(id: string) { return this.operations.get(id); }
  async findByProviderOperation(provider: string, providerOperationId: string) { return [...this.operations.values()].find((operation) => operation.provider === provider && operation.providerOperationId === providerOperationId); }
  async save(operation: import("./publication-operation.js").PublicationOperation) { this.operations.set(operation.id, operation); return operation; }
  async saveIfAbsent(operation: import("./publication-operation.js").PublicationOperation) {
    const existing = await this.findByProviderOperation(operation.provider, operation.providerOperationId);
    if (existing) return existing;
    this.operations.set(operation.id, operation);
    return operation;
  }
}
