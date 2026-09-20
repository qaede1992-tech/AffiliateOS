import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousRunService } from "../../src/domain/autonomous-run-service.js";
import { InMemoryAutonomousRunRepository } from "../../src/domain/autonomous-run.js";

describe("autonomous run", () => {
  it("accepts the same idempotency key only once", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const first = await service.accept({ idempotencyKey: "run-1", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const second = await service.accept({ idempotencyKey: "run-1", productId: "product-2", offerId: "offer-2", now: new Date("2026-09-20T10:01:00.000Z") });
    assert.equal(second.id, first.id);
    assert.equal(second.opportunityProductId, "product-1");
    assert.equal(second.offerId, "offer-1");
  });

  it("claims an accepted run exactly once", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-claim", productId: "product-1", offerId: "offer-1" });
    const [first, second] = await Promise.all([
      service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z")),
      service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:01.000Z"))
    ]);
    assert.equal([first.acquired, second.acquired].filter(Boolean).length, 1);
    assert.equal((await repository.findById(accepted.id))?.status, "processing");
  });

  it("does not reclaim a run already in progress", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-busy", productId: "product-1", offerId: "offer-1" });
    const first = await service.claimProcessing(accepted.id);
    const second = await service.claimProcessing(accepted.id);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.run.status, "processing");
  });

  it("reclaims a failed run and clears the previous error", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-retry", productId: "product-1", offerId: "offer-1" });
    const processing = await service.transition(accepted.id, "processing");
    const failed = await service.transition(processing.id, "failed", { campaignId: "campaign-1", error: "temporary distribution failure" });
    const retry = await service.claimProcessing(failed.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(retry.acquired, true);
    assert.equal(retry.run.status, "processing");
    assert.equal(retry.run.campaignId, "campaign-1");
    assert.equal(retry.run.lastError, undefined);
  });

  it("persists campaign binding and errors through lifecycle transitions", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-2", productId: "product-1", offerId: "offer-1" });
    const processing = await service.transition(accepted.id, "processing");
    assert.equal(processing.status, "processing");
    const failed = await service.transition(processing.id, "failed", { campaignId: "campaign-1", error: "distribution unavailable" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.campaignId, "campaign-1");
    assert.equal(failed.lastError, "distribution unavailable");
  });

  it("rejects stale compare-and-set transitions", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-3", productId: "product-1", offerId: "offer-1" });
    const processing = await service.transition(accepted.id, "processing");
    const stale = await repository.transition(processing.id, ["accepted"], { ...processing, status: "failed" });
    assert.equal(stale, undefined);
    assert.equal((await repository.findById(processing.id))?.status, "processing");
  });
});
