import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousRunService } from "../../src/domain/autonomous-run-service.js";
import { createAutonomousRun, InMemoryAutonomousRunRepository } from "../../src/domain/autonomous-run.js";

describe("AutonomousRunService", () => {
  it("allows only one concurrent claimant for an accepted run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({
      idempotencyKey: "autonomous:test:claim",
      productId: "product-1",
      offerId: "offer-1",
      now: new Date("2026-09-20T10:00:00.000Z")
    });

    const [first, second] = await Promise.all([
      service.claimProcessing(accepted.id, new Date("2026-09-20T10:01:00.000Z")),
      service.claimProcessing(accepted.id, new Date("2026-09-20T10:01:00.000Z"))
    ]);

    assert.equal([first.acquired, second.acquired].filter(Boolean).length, 1);
    const stored = await repository.findById(accepted.id);
    assert.equal(stored?.status, "processing");
    assert.equal(stored?.attemptCount, 1);
  });

  it("does not claim a failed run with an invalid retry timestamp", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const run = createAutonomousRun({
      idempotencyKey: "autonomous:test:invalid-retry-time",
      productId: "product-1",
      offerId: "offer-1",
      now: new Date("2026-09-20T10:00:00.000Z")
    });
    await repository.save({
      ...run,
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: "not-a-timestamp",
      updatedAt: "2026-09-20T10:01:00.000Z"
    });

    const claim = await service.claimProcessing(run.id, new Date("2026-09-20T11:00:00.000Z"));

    assert.equal(claim.acquired, false);
    assert.equal(claim.run.status, "failed");
  });

  it("does not reclaim a fresh processing run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const run = createAutonomousRun({
      idempotencyKey: "autonomous:test:fresh",
      productId: "product-1",
      offerId: "offer-1",
      now: new Date("2026-09-20T10:00:00.000Z")
    });
    await repository.save({ ...run, status: "processing", attemptCount: 1, updatedAt: "2026-09-20T10:05:00.000Z" });

    const claim = await service.claimProcessing(run.id, new Date("2026-09-20T10:10:00.000Z"));

    assert.equal(claim.acquired, false);
    assert.equal(claim.run.status, "processing");
    assert.equal(claim.run.attemptCount, 1);
  });
});
