import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousRunService } from "../../src/domain/autonomous-run-service.js";
import { InMemoryAutonomousRunRepository, createAutonomousRun } from "../../src/domain/autonomous-run.js";

describe("autonomous run recovery", () => {
  it("reclaims a stale processing run atomically", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const accepted = createAutonomousRun({
      idempotencyKey: "recovery-test",
      productId: "product-1",
      offerId: "offer-1",
      now: new Date("2026-09-21T10:00:00.000Z")
    });
    await repository.save({ ...accepted, status: "processing", updatedAt: "2026-09-21T10:00:00.000Z" });

    const service = new AutonomousRunService(repository);
    const result = await service.claimProcessing(
      accepted.id,
      new Date("2026-09-21T10:31:00.000Z"),
      30 * 60 * 1000
    );

    assert.equal(result.acquired, true);
    assert.equal(result.run.status, "processing");
    assert.equal(result.run.updatedAt, "2026-09-21T10:31:00.000Z");
  });

  it("does not reclaim a live processing run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const accepted = createAutonomousRun({
      idempotencyKey: "live-test",
      productId: "product-1",
      offerId: "offer-1",
      now: new Date("2026-09-21T10:00:00.000Z")
    });
    await repository.save({ ...accepted, status: "processing", updatedAt: "2026-09-21T10:20:00.000Z" });

    const service = new AutonomousRunService(repository);
    const result = await service.claimProcessing(
      accepted.id,
      new Date("2026-09-21T10:31:00.000Z"),
      30 * 60 * 1000
    );

    assert.equal(result.acquired, false);
    assert.equal(result.run.updatedAt, "2026-09-21T10:20:00.000Z");
  });
});
