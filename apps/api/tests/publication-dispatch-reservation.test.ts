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
