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

test("ambiguous dispatch outcomes cannot be marked safe to retry without reconciliation proof", async () => {
  const repository = new InMemoryPublicationDispatchReservationRepository();
  await repository.reserve(reservation());
  await repository.transition("reservation-1", ["reserved"], reservation({ state: "dispatching" }));
  await repository.transition("reservation-1", ["dispatching"], reservation({ state: "uncertain" }));
  assert.equal(await repository.transition("reservation-1", ["uncertain"], reservation({ state: "safe_to_retry" })), undefined);
  await repository.transition("reservation-1", ["uncertain"], reservation({ state: "needs_reconciliation" }));
  assert.equal(await repository.transition("reservation-1", ["needs_reconciliation"], reservation({ state: "safe_to_retry" })), undefined);
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

test("Instagram accepted response persistence failure keeps the dispatch fence", async () => {
  const { PublisherExecutor } = await import("../src/domain/publisher-executor.js");
  const backing = new InMemoryPublicationDispatchReservationRepository();
  const repository = {
    findByJobProvider: (jobId: string, provider: string) => backing.findByJobProvider(jobId, provider),
    reserve: (value: PublicationDispatchReservation) => backing.reserve(value),
    transition: async (id: string, expected: import("../src/domain/publication-dispatch-reservation.js").PublicationDispatchState[], next: PublicationDispatchReservation) => {
      if (next.state === "accepted") throw new Error("Database unavailable while saving provider acceptance.");
      return backing.transition(id, expected, next);
    }
  };
  const content = {
    id: "content-persist",
    status: "scheduled",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    mediaAssetIds: [],
    socialAccountId: "account-persist"
  };
  const account = {
    id: "account-persist",
    platform: "instagram",
    status: "active",
    accountReference: "instagram-account"
  };
  const contentService = {
    get: async () => content,
    validatePublicationEligibility: async () => undefined,
    update: async (_id: string, changes: Record<string, unknown>) => ({ ...content, ...changes })
  };
  const publisher = {
    provider: "instagram-graph",
    supports: (platform: string) => platform === "instagram",
    publish: async () => ({ status: "accepted" as const, providerOperationId: "meta-container-789" })
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
    repository as never
  );

  await assert.rejects(
    executor.execute(content.id, new Date("2026-11-16T00:00:00.000Z"), "job-persist:instagram-graph", undefined, "job-persist"),
    /Database unavailable while saving provider acceptance/
  );

  const saved = await backing.findByJobProvider("job-persist", "instagram-graph");
  assert.equal(saved?.state, "dispatching");
  assert.equal(saved?.providerOperationId, undefined);
});

test("two publication workers competing for one Instagram job dispatch through the provider only once", async () => {
  const { InMemoryPublicationJobRepository } = await import("../src/domain/publication-job.js");
  const { PublicationJobService } = await import("../src/domain/publication-job-service.js");
  const { PublicationWorker } = await import("../src/domain/publication-worker.js");
  const { PublisherExecutor } = await import("../src/domain/publisher-executor.js");

  const now = new Date("2026-11-16T02:00:00.000Z");
  const jobs = new InMemoryPublicationJobRepository();
  await jobs.save({
    id: "job-concurrent",
    contentId: "content-concurrent",
    idempotencyKey: "content:content-concurrent",
    status: "pending",
    attemptCount: 0,
    scheduledAt: "2026-11-15T00:00:00.000Z",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z"
  });

  let contentStatus = "scheduled";
  const content = {
    id: "content-concurrent",
    status: "scheduled",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    mediaAssetIds: [],
    socialAccountId: "account-concurrent"
  };
  const contentService = {
    get: async () => ({ ...content, status: contentStatus }),
    validatePublicationEligibility: async () => undefined,
    update: async (_id: string, changes: Record<string, unknown>) => {
      if (typeof changes.status === "string") contentStatus = changes.status;
      return { ...content, status: contentStatus, ...changes };
    }
  };
  const account = {
    id: "account-concurrent",
    platform: "instagram",
    status: "active",
    accountReference: "instagram-account"
  };
  const reservations = new InMemoryPublicationDispatchReservationRepository();
  let publishCalls = 0;
  const publisher = {
    provider: "instagram-graph",
    supports: (platform: string) => platform === "instagram",
    publish: async () => {
      publishCalls += 1;
      // Hold the first dispatch open long enough for the competing worker to
      // reach its claim attempt. The durable job claim must exclude it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "published" as const, externalPostId: "meta-post-concurrent" };
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
    reservations
  );
  const jobService = new PublicationJobService(jobs);
  const operations = new (await import("../src/domain/publication-operation.js")).InMemoryPublicationOperationRepository();
  const workerA = new PublicationWorker(jobs, jobService, executor, contentService as never, operations, reservations);
  const workerB = new PublicationWorker(jobs, jobService, executor, contentService as never, operations, reservations);

  const results = await Promise.all([workerA.runOnce(now), workerB.runOnce(now)]);
  const savedJob = await jobs.findById("job-concurrent");
  const savedReservation = await reservations.findByJobProvider("job-concurrent", "instagram-graph");

  assert.equal(publishCalls, 1);
  assert.equal(savedReservation?.state, "published");
  assert.equal(savedReservation?.externalPostId, "meta-post-concurrent");
  assert.equal(savedJob?.status, "succeeded");
  assert.equal(savedJob?.externalPostId, "meta-post-concurrent");
  assert.equal(results.flat().filter((result) => result.status === "succeeded").length, 1);
});

test("Instagram accepted response without a provider operation ID is fenced as uncertain", async () => {
  const { PublisherExecutor } = await import("../src/domain/publisher-executor.js");
  const repository = new InMemoryPublicationDispatchReservationRepository();
  const content = {
    id: "content-accepted-missing-id",
    status: "scheduled",
    scheduledAt: "2026-11-15T00:00:00.000Z",
    platform: "instagram",
    contentType: "image",
    mediaAssetIds: [],
    socialAccountId: "account-accepted-missing-id"
  };
  const account = {
    id: "account-accepted-missing-id",
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
      return { status: "accepted" } as never;
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
    executor.execute(content.id, new Date("2026-11-16T00:00:00.000Z"), "job-accepted-missing-id:instagram-graph", undefined, "job-accepted-missing-id"),
    /accepted without a provider operation ID; automatic redispatch is blocked/
  );

  const saved = await repository.findByJobProvider("job-accepted-missing-id", "instagram-graph");
  assert.equal(publishCalls, 1);
  assert.equal(saved?.state, "uncertain");
  assert.equal(saved?.providerOperationId, undefined);
  assert.match(saved?.lastError ?? "", /accepted without a provider operation ID/);
});
