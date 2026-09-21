import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content } from "@affiliateos/shared";
import { InMemoryPublicationJobRepository, createPublicationJob } from "../../src/domain/publication-job.js";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";

const content: Content = {
  id: "content-1", platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled",
  scheduledAt: "2026-09-20T10:00:00.000Z", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

describe("PublicationJobService", () => {
  it("creates deterministic idempotency and returns the existing job on duplicate enqueue", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const first = await service.enqueue(content);
    const second = await service.enqueue(content);
    assert.equal(first.id, second.id);
    assert.equal(first.idempotencyKey, "content:content-1");
  });

  it("preserves one job under concurrent enqueue calls", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const jobs = await Promise.all(Array.from({ length: 20 }, () => service.enqueue(content)));
    const stored = await repo.list();
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    assert.equal(stored.length, 1);
  });

  it("claims a due job exactly once while its lock is fresh", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    const now = new Date("2026-09-20T11:00:00.000Z");
    const [firstClaim, secondClaim] = await Promise.all([
      service.claim(job.id, now),
      service.claim(job.id, now)
    ]);
    const claims = [firstClaim, secondClaim].filter(Boolean);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.status, "processing");
    assert.equal(claims[0]?.attemptCount, 1);
  });

  it("does not claim a future job", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    assert.equal(await service.claim(job.id, new Date("2026-09-20T09:00:00.000Z")), undefined);
  });

  it("does not let a stale worker overwrite a terminal failure", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    await service.claim(job.id, new Date("2026-09-20T11:00:00.000Z"));
    const failed = await service.fail(job.id, new Error("provider timeout"), new Date("2026-09-20T11:01:00.000Z"));
    const staleSuccess = await service.succeed(job.id, "late-post", new Date("2026-09-20T11:02:00.000Z"));
    assert.equal(failed.status, "failed");
    assert.equal(staleSuccess.status, "failed");
    assert.equal((await repo.findById(job.id))?.status, "failed");
  });

  it("records success and failure state", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    await service.claim(job.id, new Date("2026-09-20T11:00:00.000Z"));
    const succeeded = await service.succeed(job.id, "post-1", new Date("2026-09-20T11:01:00.000Z"));
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.externalPostId, "post-1");

    const retryJob = createPublicationJob({ ...content, id: "content-2" });
    await repo.save(retryJob);
    await service.claim(retryJob.id, new Date("2026-09-20T11:00:00.000Z"));
    const failed = await service.fail(retryJob.id, new Error("provider timeout"), new Date("2026-09-20T11:02:00.000Z"));
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "provider timeout");
  });
});
