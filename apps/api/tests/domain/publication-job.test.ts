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

  it("claims a due job exactly once while its lock is fresh", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    const now = new Date("2026-09-20T11:00:00.000Z");
    const claimed = await service.claim(job.id, now);
    const duplicateClaim = await service.claim(job.id, new Date("2026-09-20T11:05:00.000Z"));
    assert.equal(claimed?.status, "processing");
    assert.equal(claimed?.attemptCount, 1);
    assert.equal(duplicateClaim, undefined);
  });

  it("does not claim a future job", async () => {
    const repo = new InMemoryPublicationJobRepository();
    const service = new PublicationJobService(repo);
    const job = await service.enqueue(content);
    assert.equal(await service.claim(job.id, new Date("2026-09-20T09:00:00.000Z")), undefined);
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
