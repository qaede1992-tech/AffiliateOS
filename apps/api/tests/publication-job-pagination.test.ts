import assert from "node:assert/strict";
import test from "node:test";
import type { PublicationJob } from "../src/domain/publication-job.js";
import { InMemoryPublicationJobRepository } from "../src/domain/publication-job.js";
import { PublicationJobService } from "../src/domain/publication-job-service.js";

const job = (id: string, status: PublicationJob["status"], scheduledAt: string): PublicationJob => ({
  id,
  contentId: "00000000-0000-4000-8000-000000000099",
  idempotencyKey: `content:${id}`,
  status,
  attemptCount: 0,
  scheduledAt,
  createdAt: scheduledAt,
  updatedAt: scheduledAt
});

test("pending publication approval pages are bounded, stable, and exclude other statuses", async () => {
  const repository = new InMemoryPublicationJobRepository();
  const service = new PublicationJobService(repository);
  await repository.save(job("00000000-0000-4000-8000-000000000001", "pending_approval", "2026-01-01T01:00:00.000Z"));
  await repository.save(job("00000000-0000-4000-8000-000000000002", "pending_approval", "2026-01-01T02:00:00.000Z"));
  await repository.save(job("00000000-0000-4000-8000-000000000003", "pending", "2026-01-01T03:00:00.000Z"));

  const first = await service.listPendingApprovalPage({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.id, "00000000-0000-4000-8000-000000000002");
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await service.listPendingApprovalPage({ limit: 1, cursor: first.nextCursor ?? undefined });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]?.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("pending publication approval pages reject malformed cursors", async () => {
  const service = new PublicationJobService(new InMemoryPublicationJobRepository());
  await assert.rejects(
    service.listPendingApprovalPage({ limit: 10, cursor: "not-a-cursor" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_PUBLICATION_JOB_CURSOR"
  );
});
