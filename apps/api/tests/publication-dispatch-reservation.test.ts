import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryPublicationDispatchReservationRepository,
  type PublicationDispatchReservation
} from "../src/domain/publication-dispatch-reservation.js";

const reservation = (overrides: Partial<PublicationDispatchReservation> = {}): PublicationDispatchReservation => ({
  id: "reservation-1",
  jobId: "job-1",
  contentId: "content-1",
  provider: "instagram-graph",
  state: "reserved",
  idempotencyKey: "job-1:instagram-graph",
  snapshot: { mediaAssetIds: ["asset-a", "asset-b"] },
  snapshotHash: "sha256-snapshot",
  createdAt: "2026-11-16T00:00:00.000Z",
  updatedAt: "2026-11-16T00:00:00.000Z",
  ...overrides
});

test("dispatch reservation is unique per job and provider", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  const first = await repository.reserve(reservation());
  const duplicate = await repository.reserve(reservation({ id: "reservation-2", snapshotHash: "different" }));

  assert.equal(first.id, "reservation-1");
  assert.equal(duplicate.id, "reservation-1");
  assert.equal(duplicate.snapshotHash, "sha256-snapshot");
});

test("concurrent in-memory reservations converge on one job/provider row", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  const results = await Promise.all([
    repository.reserve(reservation({ id: "reservation-a" })),
    repository.reserve(reservation({ id: "reservation-b" }))
  ]);

  assert.equal(results[0]?.id, results[1]?.id);
  assert.equal((await repository.findByJobProvider("job-1", "instagram-graph"))?.id, results[0]?.id);
});

test("dispatch reservation transitions use compare-and-set and preserve immutable snapshot", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  await repository.reserve(reservation());

  const claimed = await repository.transition("reservation-1", ["reserved"], reservation({
    state: "dispatching",
    snapshot: { mediaAssetIds: ["tampered"] },
    snapshotHash: "tampered",
    idempotencyKey: "tampered",
    dispatchStartedAt: "2026-11-16T00:01:00.000Z",
    updatedAt: "2026-11-16T00:01:00.000Z"
  }));

  assert.ok(claimed);
  assert.equal(claimed.state, "dispatching");
  assert.deepEqual(claimed.snapshot, { mediaAssetIds: ["asset-a", "asset-b"] });
  assert.equal(claimed.snapshotHash, "sha256-snapshot");
  assert.equal(claimed.idempotencyKey, "job-1:instagram-graph");
  assert.equal(await repository.transition("reservation-1", ["reserved"], reservation({ state: "dispatching" })), undefined);
  assert.equal(await repository.transition("reservation-1", ["dispatching"], reservation({ state: "reserved" })), undefined);
});

test("dispatch reservation records ambiguous provider outcomes without allowing redispatch", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  await repository.reserve(reservation());
  await repository.transition("reservation-1", ["reserved"], reservation({ state: "dispatching" }));

  const uncertain = await repository.transition("reservation-1", ["dispatching"], reservation({
    state: "uncertain",
    lastError: "provider timeout"
  }));

  assert.equal(uncertain?.state, "uncertain");
  assert.equal(await repository.transition("reservation-1", ["uncertain"], reservation({ state: "dispatching" })), undefined);
});

test("published dispatch reservation retains external post ID for restart recovery", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  await repository.reserve(reservation());
  await repository.transition("reservation-1", ["reserved"], reservation({ state: "dispatching" }));
  const published = await repository.transition("reservation-1", ["dispatching"], reservation({
    state: "published",
    externalPostId: "instagram-post-123"
  }));
  assert.equal(published?.state, "published");
  assert.equal(published?.externalPostId, "instagram-post-123");
});

test("Instagram publisher success without an external post ID is fenced as uncertain", async () => {
  const { PublisherExecutor } = await import("../src/domain/publisher-executor.js");
  const repository = new InMemoryPublicationDispatchReservationRepository();
  const content = {
    id: "content-1",
    status: "scheduled",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    title: "Test",
    caption: "Test caption",
    script: null,
    cta: null,
    mediaAssetIds: [],
    productId: null,
    socialAccountId: "account-1"
  };
  const account = {
    id: "account-1",
    platform: "instagram",
    status: "active",
    accountReference: "instagram-account"
  };
  const contentService = {
    get: async () => content,
    validatePublicationEligibility: async () => undefined,
    update: async (_id: string, changes: Record<string, unknown>) => ({ ...content, ...changes })
  };
  const socialAccounts = { list: async () => [account] };
  const publisher = {
    provider: "instagram-graph",
    supports: (platform: string) => platform === "instagram",
    publish: async () => ({ status: "published" as const, externalPostId: "" })
  };
  const executor = new PublisherExecutor(
    contentService as never,
    socialAccounts as never,
    [publisher],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    repository
  );

  await assert.rejects(
    executor.execute(content.id, new Date("2026-11-16T00:00:00.000Z"), "job-1:instagram-graph", undefined, "job-1"),
    /without an external post ID; automatic redispatch is blocked/
  );

  const saved = await repository.findByJobProvider("job-1", "instagram-graph");
  assert.equal(saved?.state, "uncertain");
  assert.equal(saved?.externalPostId, undefined);
  assert.match(saved?.lastError ?? "", /without an external post ID/);
});

test("publication worker restores a published Instagram reservation after a failed job restart", async () => {
  const { InMemoryPublicationJobRepository } = await import("../src/domain/publication-job.js");
  const { PublicationJobService } = await import("../src/domain/publication-job-service.js");
  const { PublicationWorker } = await import("../src/domain/publication-worker.js");
  const { InMemoryPublicationOperationRepository } = await import("../src/domain/publication-operation.js");

  const now = new Date("2026-11-16T01:00:00.000Z");
  const jobs = new InMemoryPublicationJobRepository();
  await jobs.save({
    id: "job-1",
    contentId: "content-1",
    idempotencyKey: "content:content-1",
    status: "failed",
    attemptCount: 1,
    scheduledAt: "2026-11-15T00:00:00.000Z",
    lastError: "worker stopped before finalizing job",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z"
  });

  const content = {
    id: "content-1",
    status: "published",
    publishedAt: "2026-11-16T00:30:00.000Z",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    mediaAssetIds: [],
    socialAccountId: "account-1"
  };
  const contentService = {
    get: async () => content,
    update: async (_id: string, changes: Record<string, unknown>) => ({ ...content, ...changes }),
    validatePublicationEligibility: async () => undefined
  };
  const executor = {
    execute: async () => { throw new Error("Executor must not dispatch during reservation recovery."); },
    check: async () => { throw new Error("No provider reconciliation should be needed for a published reservation."); }
  };
  const reservations = new InMemoryPublicationDispatchReservationRepository();
  await reservations.reserve(reservation({
    state: "published",
    externalPostId: "meta-post-456",
    updatedAt: "2026-11-16T00:30:00.000Z"
  }));
  const worker = new PublicationWorker(
    jobs,
    new PublicationJobService(jobs),
    executor as never,
    contentService as never,
    new InMemoryPublicationOperationRepository(),
    reservations
  );

  const results = await worker.runOnce(now);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "succeeded");
  assert.equal(results[0]?.externalPostId, "meta-post-456");
  const savedJob = await jobs.findById("job-1");
  assert.equal(savedJob?.status, "succeeded");
  assert.equal(savedJob?.externalPostId, "meta-post-456");
});

test("Instagram provider timeout moves the durable reservation to uncertain", async () => {
  const { PublisherExecutor } = await import("../src/domain/publisher-executor.js");
  const repository = new InMemoryPublicationDispatchReservationRepository();
  const content = {
    id: "content-timeout",
    status: "scheduled",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    mediaAssetIds: [],
    socialAccountId: "account-timeout"
  };
  const account = {
    id: "account-timeout",
    platform: "instagram",
    status: "active",
    accountReference: "instagram-account"
  };
  const contentService = {
    get: async () => content,
    validatePublicationEligibility: async () => undefined,
    update: async (_id: string, changes: Record<string, unknown>) => ({ ...content, ...changes })
  };
  let publishCalls = 0;
  const publisher = {
    provider: "instagram-graph",
    supports: (platform: string) => platform === "instagram",
    publish: async () => {
      publishCalls += 1;
      throw new Error("Meta request timed out after dispatch.");
    }
  };
  const executor = new PublisherExecutor(
    contentService as never,
    { list: async () => [account] } as never,
    [publisher],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    repository
  );

  await assert.rejects(
    executor.execute(content.id, new Date("2026-11-16T00:00:00.000Z"), "job-timeout:instagram-graph", undefined, "job-timeout"),
    /Meta request timed out/
  );

  const saved = await repository.findByJobProvider("job-timeout", "instagram-graph");
  assert.equal(publishCalls, 1);
  assert.equal(saved?.state, "uncertain");
  assert.match(saved?.lastError ?? "", /timed out/);
});

