import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryPublicationJobRepository } from "../src/domain/publication-job.js";
import { PublicationJobService } from "../src/domain/publication-job-service.js";

const makeJob = (id: string, scheduledAt: string, status: "pending_approval" | "succeeded" = "pending_approval") => ({
  id,
  contentId: "00000000-0000-4000-8000-000000000001",
  idempotencyKey: `job-${id}`,
  status,
  attemptCount: 0,
  scheduledAt,
  createdAt: scheduledAt,
  updatedAt: scheduledAt
});

test("pending publication approval pagination is bounded, ordered, and excludes other statuses", async () => {
  const repository = new InMemoryPublicationJobRepository();
  const service = new PublicationJobService(repository);
  const scheduledAt = "2026-11-17T00:00:00.000Z";
  await repository.save(makeJob("00000000-0000-4000-8000-000000000003", scheduledAt));
  await repository.save(makeJob("00000000-0000-4000-8000-000000000001", scheduledAt));
  await repository.save(makeJob("00000000-0000-4000-8000-000000000002", scheduledAt, "succeeded"));

  const first = await service.listPendingApprovalPage({ limit: 1 });
  assert.deepEqual(first.items.map((job) => job.id), ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await service.listPendingApprovalPage({ limit: 1, cursor: first.nextCursor ?? undefined });
  assert.deepEqual(second.items.map((job) => job.id), ["00000000-0000-4000-8000-000000000003"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("pending publication approval pagination rejects malformed cursors", async () => {
  const service = new PublicationJobService(new InMemoryPublicationJobRepository());
  await assert.rejects(
    service.listPendingApprovalPage({ limit: 10, cursor: "not-a-valid-cursor" }),
    /cursor is invalid/i
  );
});
