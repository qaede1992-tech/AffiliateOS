import type { EntityId } from "@affiliateos/shared";
import { ContentService } from "./content.js";
import { PublisherExecutor } from "./publisher-executor.js";
import type { PublicationJob } from "./publication-job.js";
import { PublicationJobService } from "./publication-job-service.js";
import type { PublicationJobRepository } from "./publication-job.js";
import { PublicationOperationService } from "./publication-operation-service.js";
import { InMemoryPublicationOperationRepository, type PublicationOperationRepository } from "./publication-operation.js";

const ACCEPTED_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const PROCESSING_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const RECONCILIATION_BATCH_LIMIT = 100;
const PUBLICATION_JOB_BATCH_LIMIT = 100;
export const PUBLICATION_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

import { MAX_PUBLICATION_JOB_ATTEMPTS, publicationRetryDelayMs } from "./publication-job.js";
export { publicationRetryDelayMs } from "./publication-job.js";
export type PublicationWorkerResult = {
  jobId: EntityId;
  contentId: EntityId;
  status: "succeeded" | "failed" | "pending_approval" | "awaiting_confirmation" | "processing" | "skipped";
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
    this.operations = new PublicationOperationService(operationRepository ?? new InMemoryPublicationOperationRepository());
  }

  async nextWakeAt(): Promise<Date | undefined> {
    if (!this.jobs.nextWakeAt) throw new Error("Publication job repository must implement bounded nextWakeAt().");
    const jobsWakeAt = await this.jobs.nextWakeAt(PUBLICATION_JOB_LOCK_TIMEOUT_MS);
    const earliestOperationUpdatedAt = await this.operations.findEarliestReconciliationUpdatedAt();
    const operationWakeAt = earliestOperationUpdatedAt
      ? new Date(new Date(earliestOperationUpdatedAt).getTime() + ACCEPTED_RECONCILIATION_DELAY_MS)
      : undefined;
    const candidates = [jobsWakeAt, operationWakeAt]
      .filter((candidate): candidate is Date => Boolean(candidate) && Number.isFinite(candidate!.getTime()));
    return candidates.length > 0
      ? new Date(Math.min(...candidates.map((candidate) => candidate.getTime())))
      : undefined;
  }

  async runOnce(now = new Date()): Promise<PublicationWorkerResult[]> {
    const results = await this.reconcile(now);
    if (!this.jobs.listClaimable) throw new Error("Publication job repository must implement bounded listClaimable().");
    const candidates = await this.jobs.listClaimable(now, PUBLICATION_JOB_LOCK_TIMEOUT_MS, PUBLICATION_JOB_BATCH_LIMIT);

    for (const candidate of candidates) {
      if (candidate.status === "failed" && await this.shouldSkipFailedJobRetry(candidate)) continue;
      const claimed = await this.jobService.claim(candidate.id, now);
      if (!claimed) continue;
      results.push(await this.process(claimed, now));
    }
    return results;
  }

  private async shouldSkipFailedJobRetry(job: PublicationJob): Promise<boolean> {
    if (job.status !== "failed" || !this.contentService) return false;
    try {
      const content = await this.contentService.get(job.contentId);
      // A failed job is retryable only while its content remains scheduled or
      // failed (the latter is reset to scheduled by prepareRetry). Draft or
      // already-published content must not be retried by the worker.
      return content.status !== "scheduled" && content.status !== "failed";
    } catch {
      // A missing content record cannot be published; avoid retrying it forever.
      return true;
    }
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
          "SOCIAL_ACCOUNT_NOT_FOUND",
          "AFFILIATE_OFFER_NOT_AVAILABLE"
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
      const existingOperations = await this.operations.listByJobId(job.id);
      const publishedOperation = existingOperations.find((operation) => operation.status === "published" && operation.externalPostId);
      if (publishedOperation?.externalPostId) {
        await this.contentService?.update(job.contentId, { status: "published", publishedAt: now.toISOString() });
        await this.jobService.succeed(job.id, publishedOperation.externalPostId, now);
        return { jobId: job.id, contentId: job.contentId, status: "succeeded", externalPostId: publishedOperation.externalPostId };
      }
      const inFlightOperation = existingOperations.find((operation) => operation.status === "accepted" || operation.status === "processing");
      if (inFlightOperation) {
        await this.jobService.awaitConfirmation(job.id, now);
        return { jobId: job.id, contentId: job.contentId, status: "awaiting_confirmation" };
      }
      if (this.contentService) {
        const content = await this.contentService.get(job.contentId);
        if (content.platform === "tiktok" && (!job.confirmedAt || !job.tiktokApproval)) {
          await this.jobService.requestApproval(job.id, now);
          return { jobId: job.id, contentId: job.contentId, status: "pending_approval" };
        }
      }
      const result = await this.executor.execute(job.contentId, now, job.idempotencyKey, job.tiktokApproval);
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
  async listByJobId(jobId: string) {
    return [...this.operations.values()]
      .filter((operation) => operation.jobId === jobId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
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
