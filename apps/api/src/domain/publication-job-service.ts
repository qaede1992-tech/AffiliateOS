import type { Content, EntityId, TikTokPublicationApproval } from "@affiliateos/shared";
import { MAX_PUBLICATION_JOB_ATTEMPTS, publicationRetryEligibleAt, type PublicationJob, type PublicationJobRepository } from "./publication-job.js";
import { createPublicationJob } from "./publication-job.js";
import { DomainError } from "./errors.js";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export class PublicationJobService {
  constructor(private readonly jobs: PublicationJobRepository) {}

  async enqueue(content: Content): Promise<PublicationJob> {
    const job = createPublicationJob(content);
    if (this.jobs.saveIfAbsent) return this.jobs.saveIfAbsent(job);
    const existing = await this.jobs.findByIdempotencyKey(job.idempotencyKey);
    if (existing) return existing;
    return this.jobs.save(job);
  }

  async list(): Promise<PublicationJob[]> {
    return this.jobs.list();
  }

  async listPendingApprovalPage(input: { cursor?: string; limit: number }) {
    let after: { scheduledAt: string; id: EntityId } | undefined;
    if (input.cursor) {
      try {
        const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
        if (Buffer.from(decoded).toString("base64url") !== input.cursor) throw new Error("Invalid cursor encoding");
        const parsed = JSON.parse(decoded) as { scheduledAt?: unknown; id?: unknown };
        if (typeof parsed.scheduledAt !== "string" || !Number.isFinite(Date.parse(parsed.scheduledAt)) ||
          typeof parsed.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)) {
          throw new Error("Invalid cursor payload");
        }
        after = { scheduledAt: parsed.scheduledAt, id: parsed.id };
      } catch {
        throw new DomainError("INVALID_PUBLICATION_JOB_CURSOR", "Publication job cursor is invalid.", 400);
      }
    }
    const rows = this.jobs.listPendingApprovalPage
      ? await this.jobs.listPendingApprovalPage({ ...(after ? { after } : {}), limit: input.limit + 1 })
      : (await this.jobs.list()).filter((job) => job.status === "pending_approval" && (!after ||
          job.scheduledAt < after.scheduledAt || (job.scheduledAt === after.scheduledAt && job.id < after.id)))
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || b.id.localeCompare(a.id))
        .slice(0, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ scheduledAt: last.scheduledAt, id: last.id })).toString("base64url")
        : null
    };
  }

  async get(id: EntityId): Promise<PublicationJob | undefined> {
    return this.jobs.findById(id);
  }

  async claim(id: EntityId, now = new Date()): Promise<PublicationJob | undefined> {
    if (this.jobs.claimDue) return this.jobs.claimDue(id, now, LOCK_TIMEOUT_MS);
    const job = await this.jobs.findById(id);
    if (!job) return undefined;
    if (job.status === "failed" && job.attemptCount >= MAX_PUBLICATION_JOB_ATTEMPTS) return undefined;
    const scheduledAt = new Date(job.scheduledAt).getTime();
    if (!Number.isFinite(scheduledAt) || scheduledAt > now.getTime()) return undefined;
    if (job.status === "failed" && publicationRetryEligibleAt(job) > now.getTime()) return undefined;
    if (job.status === "processing") {
      if (!job.lockedAt) return undefined;
      const lockAge = now.getTime() - new Date(job.lockedAt).getTime();
      if (!Number.isFinite(lockAge) || lockAge < LOCK_TIMEOUT_MS) return undefined;
    } else if (job.status !== "pending" && job.status !== "failed") {
      return undefined;
    }
    return this.jobs.save({
      ...job,
      status: "processing",
      attemptCount: job.attemptCount + 1,
      lockedAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
  }

  async confirm(id: EntityId, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    if (job.status !== "pending_approval") throw new Error("Publication job is not awaiting approval.");
    const next = { ...job, status: "pending" as const, confirmedAt: now.toISOString(), updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["pending_approval"], next)) ?? job : this.jobs.save(next);
  }

  async confirmWithApproval(id: EntityId, approval: TikTokPublicationApproval, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    if (job.status !== "pending_approval") throw new Error("Publication job is not awaiting approval.");
    if (!approval.musicUsageConfirmed || !approval.previewConfirmed) throw new Error("TikTok publication requires explicit preview and music usage confirmation.");
    if (approval.commercialDisclosureEnabled && !approval.brandOrganicToggle && !approval.brandContentToggle) {
      throw new Error("Commercial disclosure requires at least one brand category.");
    }
    if (approval.brandContentToggle && !["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"].includes(approval.privacyLevel)) {
      throw new Error("Branded content cannot use private or follower-only visibility.");
    }
    const next = { ...job, status: "pending" as const, confirmedAt: now.toISOString(), tiktokApproval: approval, updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["pending_approval"], next)) ?? job : this.jobs.save(next);
  }

  async requestApproval(id: EntityId, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const next = { ...job, status: "pending_approval" as const, lockedAt: undefined, lastError: undefined, confirmedAt: undefined, tiktokApproval: undefined, updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["processing"], next)) ?? job : this.jobs.save(next);
  }

  async awaitConfirmation(id: EntityId, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const next = { ...job, status: "awaiting_confirmation" as const, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["processing"], next)) ?? job : this.jobs.save(next);
  }

  async succeed(id: EntityId, externalPostId: string, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const next = { ...job, status: "succeeded" as const, externalPostId, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["processing", "awaiting_confirmation"], next)) ?? job : this.jobs.save(next);
  }

  async fail(id: EntityId, error: unknown, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const message = error instanceof Error ? error.message : String(error);
    const next = { ...job, status: "failed" as const, lockedAt: undefined, lastError: message, confirmedAt: undefined, tiktokApproval: undefined, updatedAt: now.toISOString() };
    return this.jobs.transition ? (await this.jobs.transition(id, ["processing", "awaiting_confirmation"], next)) ?? job : this.jobs.save(next);
  }

  private async require(id: EntityId) {
    const job = await this.jobs.findById(id);
    if (!job) throw new Error("Publication job does not exist.");
    return job;
  }
}
