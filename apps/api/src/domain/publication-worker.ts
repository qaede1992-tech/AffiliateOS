import type { EntityId } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import { ContentService } from "./content.js";
import { PublisherExecutor } from "./publisher-executor.js";
import type { PublicationJob } from "./publication-job.js";
import { PublicationJobService } from "./publication-job-service.js";
import type { PublicationJobRepository } from "./publication-job.js";
import { PublicationOperationService } from "./publication-operation-service.js";
import type { PublicationOperationRepository } from "./publication-operation.js";

const INITIAL_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const ACCEPTED_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const PROCESSING_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
export const PUBLICATION_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export const publicationRetryDelayMs = (attemptCount: number): number => {
  if (attemptCount <= 0) return 0;
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** (attemptCount - 1));
};

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

const isStatusCheckUnavailable = (message: string): boolean =>
  message.includes("does not support publication status checks");

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

  async listOperations() {
    return this.operations.list();
  }

  async resolveConfirmation(id: EntityId, outcome: { status: "published"; externalPostId: string } | { status: "failed"; error: string }, now = new Date()): Promise<PublicationWorkerResult> {
    const operation = await this.operations.findById(id);
    if (!operation) throw new DomainError("PUBLICATION_OPERATION_NOT_FOUND", "Publication operation does not exist.", 404);
    if (operation.status !== "awaiting_confirmation") throw new DomainError("PUBLICATION_CONFIRMATION_CONFLICT", "Only publications awaiting confirmation can be resolved.", 409);
    if (outcome.status === "published") {
      const transitioned = await this.operations.transition(id, "published", { externalPostId: outcome.externalPostId }, now);
      if (transitioned.status !== "published" || transitioned.externalPostId !== outcome.externalPostId) {
        throw new DomainError("PUBLICATION_CONFIRMATION_CONFLICT", "Publication confirmation was already resolved.", 409);
      }
      await this.contentService?.update(operation.contentId, { status: "published", publishedAt: now.toISOString() });
      await this.jobService.succeed(operation.jobId, outcome.externalPostId, now);
      return { jobId: operation.jobId, contentId: operation.contentId, status: "succeeded", externalPostId: outcome.externalPostId };
    }
    const transitioned = await this.operations.transition(id, "failed", { error: outcome.error }, now);
    if (transitioned.status !== "failed" || transitioned.lastError !== outcome.error) {
      throw new Error("Publication confirmation was already resolved.");
    }
    await this.contentService?.update(operation.contentId, { status: "failed" });
    await this.jobService.fail(operation.jobId, outcome.error, now);
    return { jobId: operation.jobId, contentId: operation.contentId, status: "failed", error: outcome.error };
  }

  async runOnce(now = new Date()): Promise<PublicationWorkerResult[]> {
    const results = await this.reconcile(now);
    const candidates = (await this.jobs.list())
      .filter((job) => {
        if (!isDue(job, now)) return false;
        if (job.status === "pending") return true;
        if (job.status === "failed") return retryEligibleAt(job) <= now.getTime();
        return isStaleProcessingJob(job, now);
      })
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

    for (const candidate of candidates) {
      const claimed = await this.jobService.claim(candidate.id, now);
      if (!claimed) continue;
      results.push(await this.process(claimed, now));
    }
    return results;
  }

  private async reconcile(now: Date): Promise<PublicationWorkerResult[]> {
    const results: PublicationWorkerResult[] = [];
    for (const operation of await this.operations.list()) {
      if (operation.status === "published" && operation.externalPostId) {
        await this.contentService?.update(operation.contentId, { status: "published", publishedAt: now.toISOString() });
        await this.jobService.succeed(operation.jobId, operation.externalPostId, now);
        results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "succeeded", externalPostId: operation.externalPostId });
        continue;
      }
      if (operation.status === "failed") {
        const error = operation.lastError ?? "Publication operation failed.";
        await this.contentService?.update(operation.contentId, { status: "failed" });
        await this.jobService.fail(operation.jobId, error, now);
        results.push({ jobId: operation.jobId, contentId: operation.contentId, status: "failed", error });
        continue;
      }
      if (operation.status === "awaiting_confirmation") {
        continue;
      }
      if (operation.status !== "accepted" && operation.status !== "processing") continue;
      if (reconciliationEligibleAt(operation) > now.getTime()) continue;
      try {
        const checked = await this.executor.check(operation);
        if (checked.result.status === "processing") {
          const transitioned = await this.operations.transition(operation.id, "processing", {}, now);
          if (transitioned.status === "published" && transitioned.externalPostId) {
            await this.contentService?.update(transitioned.contentId, { status: "published", publishedAt: now.toISOString() });
            await this.jobService.succeed(transitioned.jobId, transitioned.externalPostId, now);
            results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "succeeded", externalPostId: transitioned.externalPostId });
          } else if (transitioned.status === "failed") {
            const error = transitioned.lastError ?? "Publication operation failed.";
            await this.contentService?.update(transitioned.contentId, { status: "failed" });
            await this.jobService.fail(transitioned.jobId, error, now);
            results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "failed", error });
          } else {
            results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "processing", error: transitioned.lastError });
          }
          continue;
        }
        if (checked.result.status === "published") {
          const transitioned = await this.operations.transition(operation.id, "published", { externalPostId: checked.result.externalPostId }, now);
          if (transitioned.status !== "published" || !transitioned.externalPostId) {
            throw new DomainError("PUBLICATION_OPERATION_CONFLICT", "Publication operation changed before completion could be reconciled.", 409);
          }
          await this.contentService?.update(transitioned.contentId, { status: "published", publishedAt: now.toISOString() });
          await this.jobService.succeed(transitioned.jobId, transitioned.externalPostId, now);
          results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "succeeded", externalPostId: transitioned.externalPostId });
          continue;
        }
        const transitioned = await this.operations.transition(operation.id, "failed", { error: checked.result.error }, now);
        if (transitioned.status !== "failed") {
          throw new DomainError("PUBLICATION_OPERATION_CONFLICT", "Publication operation changed before failure could be reconciled.", 409);
        }
        await this.contentService?.update(transitioned.contentId, { status: "failed" });
        await this.jobService.fail(transitioned.jobId, checked.result.error, now);
        results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "failed", error: checked.result.error });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStatusCheckUnavailable(message)) {
          const transitioned = await this.operations.transition(operation.id, "awaiting_confirmation", { error: message }, now);
          if (transitioned.status !== "awaiting_confirmation") {
            continue;
          }
          await this.jobService.awaitConfirmation(transitioned.jobId, now, message);
          results.push({ jobId: transitioned.jobId, contentId: transitioned.contentId, status: "awaiting_confirmation", error: message });
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
