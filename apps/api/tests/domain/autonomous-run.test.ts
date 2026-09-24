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

  it("does not reclaim a fresh run already in progress", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-busy", productId: "product-1", offerId: "offer-1" });
    const first = await service.claimProcessing(accepted.id);
    const second = await service.claimProcessing(accepted.id);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.run.status, "processing");
  });

  it("reclaims a stale processing run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-stale", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const processing = await service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z"));
    const freshAttempt = await service.claimProcessing(processing.run.id, new Date("2026-09-20T10:05:00.000Z"));
    assert.equal(freshAttempt.acquired, false);
    const staleAttempt = await service.claimProcessing(processing.run.id, new Date("2026-09-20T10:11:00.000Z"));
    assert.equal(staleAttempt.acquired, true);
    assert.equal(staleAttempt.run.status, "processing");
    assert.equal(staleAttempt.run.lastError, undefined);
  });

  it("reclaims a stale run exactly once under concurrency", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-race", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const processing = await service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z"));
    const [first, second] = await Promise.all([
      service.claimProcessing(processing.run.id, new Date("2026-09-20T10:11:00.000Z")),
      service.claimProcessing(processing.run.id, new Date("2026-09-20T10:11:01.000Z"))
    ]);
    assert.equal([first.acquired, second.acquired].filter(Boolean).length, 1);
    assert.equal((await repository.findById(processing.run.id))?.status, "processing");
  });

  it("lists accepted, failed, and stale processing runs but excludes fresh or completed runs", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-accepted", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const processing = await service.accept({ idempotencyKey: "run-processing", productId: "product-2", offerId: "offer-2", now: new Date("2026-09-20T09:00:00.000Z") });
    await service.claimProcessing(processing.id, new Date("2026-09-20T10:00:00.000Z"));
    const failed = await service.accept({ idempotencyKey: "run-failed", productId: "product-3", offerId: "offer-3", now: new Date("2026-09-20T10:00:00.000Z") });
    const failedProcessing = await service.claimProcessing(failed.id, new Date("2026-09-20T10:00:00.000Z"));
    await service.transition(failedProcessing.run.id, "failed", { error: "temporary failure" }, new Date("2026-09-20T10:00:01.000Z"));
    const fresh = await service.accept({ idempotencyKey: "run-fresh", productId: "product-4", offerId: "offer-4", now: new Date("2026-09-20T10:00:00.000Z") });
    await service.claimProcessing(fresh.id, new Date("2026-09-20T10:05:00.000Z"));
    const completed = await service.accept({ idempotencyKey: "run-completed", productId: "product-5", offerId: "offer-5" });
    await service.transition(completed.id, "processing");
    await service.transition(completed.id, "completed");

    const recoverable = await service.listRecoverable(new Date("2026-09-20T10:11:00.000Z"));
    assert.deepEqual(recoverable.map((run) => run.idempotencyKey).sort(), [accepted.idempotencyKey, failed.idempotencyKey, processing.idempotencyKey].sort());
  });

  it("reclaims a failed run and clears the previous error", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-retry", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const processing = await service.transition(accepted.id, "processing");
    const failed = await service.transition(processing.id, "failed", { campaignId: "campaign-1", error: "temporary distribution failure" });
    const retry = await service.claimProcessing(failed.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(retry.acquired, true);
    assert.equal(retry.run.status, "processing");
    assert.equal(retry.run.campaignId, "campaign-1");
    assert.equal(retry.run.lastError, undefined);
    assert.equal(retry.run.attemptCount, 2);
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

  it("lists runs for operator visibility with optional status filtering", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    await service.accept({ idempotencyKey: "run-list-accepted", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    const failed = await service.accept({ idempotencyKey: "run-list-failed", productId: "product-2", offerId: "offer-2", now: new Date("2026-09-20T10:01:00.000Z") });
    await service.transition(failed.id, "processing");
    await service.transition(failed.id, "failed", { error: "temporary failure" });
    const runs = await service.list({ status: "failed", limit: 10 });
    assert.deepEqual(runs.map((run) => run.idempotencyKey), ["run-list-failed"]);
  });

  it("returns a domain not-found error for an unknown run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    await assert.rejects(() => service.findById("33333333-3333-4333-8333-333333333333"), {
      code: "AUTONOMOUS_RUN_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("allows an exhausted failed run to be manually reset without changing its idempotency identity", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-manual-retry", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    let current = await service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z"));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      current = await service.transition(current.id, "failed", { error: `failure-${attempt}` }, new Date("2026-09-20T10:00:00.000Z"));
      if (attempt < 8) current = (await service.claimProcessing(current.id, new Date(current.nextAttemptAt!))).run;
    }
    const reset = await service.retry(current.id, new Date("2026-09-21T10:00:00.000Z"));
    assert.equal(reset.status, "failed");
    assert.equal(reset.attemptCount, 0);
    assert.equal(reset.nextAttemptAt, undefined);
    assert.equal(reset.lastError, undefined);
    assert.equal(reset.id, accepted.id);
    assert.equal(reset.idempotencyKey, "run-manual-retry");
    const claimed = await service.claimProcessing(reset.id, new Date("2026-09-21T10:00:01.000Z"));
    assert.equal(claimed.acquired, true);
    assert.equal(claimed.run.attemptCount, 1);
  });

  it("rejects manual retry for a completed run", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-completed-retry", productId: "product-1", offerId: "offer-1" });
    const processing = await service.claimProcessing(accepted.id);
    const completed = await service.transition(processing.run.id, "completed");
    const retry = await service.retry(completed.id);
    assert.equal(retry.status, "completed");
    assert.equal(retry.attemptCount, completed.attemptCount);
  });

  it("increments attempts when processing is started through a transition", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-transition-attempt", productId: "product-1", offerId: "offer-1" });
    const processing = await service.transition(accepted.id, "processing");
    assert.equal(processing.attemptCount, 1);
    const failed = await service.transition(processing.id, "failed", { error: "temporary failure" });
    assert.equal(failed.attemptCount, 1);
    const retry = await service.claimProcessing(failed.id, new Date(failed.nextAttemptAt!));
    assert.equal(retry.acquired, true);
    assert.equal(retry.run.attemptCount, 2);
  });

  it("backs off failed runs and stops recovery after the maximum attempts", async () => {
    const repository = new InMemoryAutonomousRunRepository();
    const service = new AutonomousRunService(repository);
    const accepted = await service.accept({ idempotencyKey: "run-exhausted", productId: "product-1", offerId: "offer-1", now: new Date("2026-09-20T10:00:00.000Z") });
    let current = await service.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z"));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const failed = await service.transition(current.run.id, "failed", { error: `failure-${attempt}` }, new Date("2026-09-20T10:00:00.000Z"));
      if (attempt < 8) {
        const expectedDelay = Math.min(60 * 60_000, 60_000 * 2 ** (attempt - 1));
        assert.equal(new Date(failed.nextAttemptAt!).getTime(), new Date("2026-09-20T10:00:00.000Z").getTime() + expectedDelay);
        current = await service.claimProcessing(failed.id, new Date(failed.nextAttemptAt!));
        assert.equal(current.acquired, true);
      } else {
        assert.equal(failed.nextAttemptAt, undefined);
        assert.equal((await service.listRecoverable(new Date("2026-09-20T12:00:00.000Z"))).some((run) => run.id === failed.id), false);
      }
    }
  });
});
