import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCycleService, type AutonomousCandidateProvider } from "../../src/domain/autonomous-cycle.js";
import type { AutonomousCycleLock } from "../../src/domain/autonomous-cycle-lock.js";
import type { AutonomousExecutionService } from "../../src/domain/autonomous-execution.js";

describe("autonomous cycle", () => {
  it("renders promo videos only after final affiliate selection and verified media eligibility", async () => {
    const candidates = ["selected-image", "media-rejected"].map((id) => ({ product: { id } as never, offers: [{} as never] }));
    const provider: AutonomousCandidateProvider = { async listCandidates() { return candidates; } };
    const calls: string[] = [];
    let videoLookupCount = 0;
    const execution = {
      async previewSelection(input: { requirePublishableMedia?: boolean; requirePublishableVideo?: boolean }) {
        if (input.requirePublishableMedia === true) {
          calls.push("media-ready-selection");
          return { selected: [{ product: candidates[0]!.product, offerId: "offer", score: 90 }], rejected: [], audit: [] };
        }
        calls.push("preliminary-selection");
        return { selected: candidates.map((candidate) => ({ product: candidate.product, offerId: "offer", score: 90 })), rejected: [], audit: [] };
      },
      async runOnce(input: { publishableMediaProductIds?: string[]; publishableVideoProductIds?: string[]; requirePublishableVideo?: boolean }) {
        calls.push("final-execution");
        assert.deepEqual(input.publishableMediaProductIds, ["selected-image", "media-rejected"]);
        assert.deepEqual(input.publishableVideoProductIds, []);
        assert.equal(input.requirePublishableVideo, true);
        return { selected: [], rejected: [], audit: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const discovery = {
      async discover(product: { id: string }) { calls.push("discover:" + product.id); return { productId: product.id, pageFetched: false, hasVideo: false, stored: [], skipped: [] }; },
      async listPublishableMediaProductIds() { calls.push("list-media"); return ["selected-image", "media-rejected"]; },
      async listMediaReadinessScores() { calls.push("media-readiness"); return { "selected-image": 85, "media-rejected": 20 }; },
      async listVideoProductIds() {
        calls.push("list-videos");
        videoLookupCount += 1;
        return videoLookupCount === 1 ? [] : ["selected-image"];
      },
      async listPublishableVideoProductIds() { calls.push("list-publishable-videos"); return []; },
      async generatePromoVideo(product: { id: string }) { calls.push("render:" + product.id); return { generated: true }; }
    };
    const service = new AutonomousCycleService(provider, execution, undefined, undefined, undefined, undefined, discovery as never);
    const result = await service.runOnce({ publicationEnabled: false });
    assert.ok(result);
    assert.deepEqual(calls, [
      "preliminary-selection",
      "discover:selected-image",
      "discover:media-rejected",
      "list-media",
      "list-videos",
      "list-publishable-videos",
      "media-readiness",
      "media-ready-selection",
      "render:selected-image",
      "list-publishable-videos",
      "final-execution"
    ]);
    assert.equal(calls.some((call) => call === "render:media-rejected"), false);
  });

  it("logs aggregate media discovery outcomes without logging source URLs", async () => {
    const product = { id: "media-product" };
    const provider: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: product as never, offers: [{} as never] }]; }
    };
    const execution = {
      async previewSelection(input: { requirePublishableMedia?: boolean }) {
        return input.requirePublishableMedia
          ? { selected: [], rejected: [], audit: [] }
          : { selected: [{ product: product as never, offerId: "offer", score: 90 }], rejected: [], audit: [] };
      },
      async runOnce() { return { selected: [], rejected: [], audit: [], outcomes: [] }; }
    } as unknown as AutonomousExecutionService;
    const discovery = {
      async discover() {
        return {
          productId: product.id,
          pageFetched: false,
          hasVideo: false,
          stored: [{ kind: "image" }],
          skipped: [{
            url: "https://shopee.co.id/private-product-path",
            reason: "Shopee product-page media extraction is disabled; only explicitly supplied catalog media can be ingested."
          }]
        };
      },
      async listPublishableMediaProductIds() { return [product.id]; },
      async listVideoProductIds() { return []; },
      async generatePromoVideo() { return { generated: false }; }
    };
    const logs: string[] = [];
    const originalInfo = console.info;
    console.info = (message?: unknown) => { logs.push(String(message)); };
    try {
      const service = new AutonomousCycleService(provider, execution, undefined, undefined, undefined, undefined, discovery as never);
      await service.runOnce({ publicationEnabled: false });
    } finally {
      console.info = originalInfo;
    }
    const summary = logs.map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
    }).find((entry) => entry?.event === "autonomous_media_discovery_summary");
    assert.ok(summary);
    assert.equal(summary.discoveryAttemptedCount, 1);
    assert.equal(summary.storedImageCount, 1);
    assert.equal(summary.storedVideoCount, 0);
    assert.deepEqual(summary.skippedReasonCounts, { shopee_catalog_media_missing: 1 });
    assert.equal(logs.some((line) => line.includes("private-product-path")), false);
  });

  it("aborts before media discovery and execution when preliminary eligibility evidence cannot be persisted", async () => {
    const product = { id: "pre-media-evidence-product" };
    const provider: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: product as never, offers: [{} as never] }]; }
    };
    let discoveryCalls = 0;
    let executionCalls = 0;
    const execution = {
      async previewSelection() {
        return {
          selected: [{ product: product as never, offerId: "offer-1", score: 90 }],
          rejected: [],
          audit: [{
            productId: product.id,
            marketplaceId: "marketplace-1",
            selected: true,
            score: 90,
            policy: {},
            reasons: ["eligible"]
          }]
        };
      },
      async runOnce() {
        executionCalls += 1;
        return { selected: [], rejected: [], audit: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const discovery = {
      async discover() {
        discoveryCalls += 1;
        return { productId: product.id, pageFetched: false, hasVideo: false, stored: [], skipped: [] };
      }
    };
    const evidenceRepository = {
      async saveMany() { const error = new Error("Failed query: INSERT INTO evidence VALUES ($1); params: private-product-data-marker"); error.name = "Error; INSERT INTO private_error_log"; throw error; },
      async listLatestByProduct() { return []; }
    };

    let lockHeld = false;
    let acquireCount = 0;
    let releaseCount = 0;
    const lock: AutonomousCycleLock = {
      async tryAcquire(key) {
        assert.equal(key, "pre-media-evidence");
        if (lockHeld) return false;
        lockHeld = true;
        acquireCount += 1;
        return true;
      },
      async release(key) {
        assert.equal(key, "pre-media-evidence");
        assert.equal(lockHeld, true);
        lockHeld = false;
        releaseCount += 1;
      }
    };
    const service = new AutonomousCycleService(
      provider,
      execution,
      lock,
      "pre-media-evidence",
      undefined,
      undefined,
      discovery as never,
      evidenceRepository
    );

    const warningLogs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warningLogs.push(args.map(String).join(" "));
    try {
      await assert.rejects(
        () => service.runOnce({ publicationEnabled: false }),
        /pre-media eligibility evidence could not be persisted; autonomous cycle aborted/i
      );
      await assert.rejects(
        () => service.runOnce({ publicationEnabled: false }),
        /pre-media eligibility evidence could not be persisted; autonomous cycle aborted/i
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warningLogs.length, 2);
    assert.ok(warningLogs.every((line) => line.includes("autonomous_pre_media_eligibility_persist_failed")));
    assert.ok(warningLogs.every((line) => line.includes('"errorType":"UnknownError"')));
    assert.ok(warningLogs.every((line) => !line.includes("private-product-data-marker")));
    assert.ok(warningLogs.every((line) => !line.includes("INSERT INTO")));
    // Both attempts must acquire and release the same lock; a failed evidence write
    // must not leave the next cycle blocked behind a leaked lock.
    assert.equal(discoveryCalls, 0);
    assert.equal(executionCalls, 0);
    assert.equal(acquireCount, 2);
    assert.equal(releaseCount, 2);
    assert.equal(lockHeld, false);
  });

  it("sanitizes database errors from media index lookups before logging", async () => {
    const product = { id: "media-index-error-product" };
    const provider: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: product as never, offers: [{} as never] }]; }
    };
    const execution = {
      async previewSelection() { return { selected: [], rejected: [], audit: [] }; },
      async runOnce() { return { selected: [], rejected: [], audit: [], outcomes: [] }; }
    } as unknown as AutonomousExecutionService;
    const discovery = {
      async discover() { return { productId: product.id, pageFetched: false, hasVideo: false, stored: [], skipped: [] }; },
      async listPublishableMediaProductIds() { return []; },
      async listVideoProductIds() {
        throw new Error("Failed query: SELECT * FROM product_media_assets WHERE product_id = $1; params: private-media-index-marker");
      },
      async listPublishableVideoProductIds() { return []; },
      async listMediaReadinessScores() { return { [product.id]: 0 }; }
    };
    const warningLogs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warningLogs.push(args.map(String).join(" "));
    try {
      const service = new AutonomousCycleService(provider, execution, undefined, undefined, undefined, undefined, discovery as never);
      await service.runOnce({ publicationEnabled: false });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warningLogs.length, 1);
    assert.ok(warningLogs[0]?.includes("autonomous_product_video_index_failed"));
    assert.ok(warningLogs[0]?.includes('"errorType":"Error"'));
    assert.equal(warningLogs.some((line) => line.includes("private-media-index-marker")), false);
    assert.equal(warningLogs.some((line) => line.includes("SELECT *")), false);
  });

  it("idles without downstream work when no marketplace candidates exist", async () => {
    const calls: string[] = [];
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() { calls.push("load-candidates"); return []; }
    };
    const execution = {
      async previewSelection() { calls.push("preview"); throw new Error("preview must not run"); },
      async runOnce() { calls.push("execution"); throw new Error("execution must not run"); }
    } as unknown as AutonomousExecutionService;
    const optimization = { async run() { calls.push("optimization"); throw new Error("optimization must not run"); } };
    const exploration = { async run() { calls.push("exploration"); throw new Error("exploration must not run"); } };
    const media = {
      async discover() { calls.push("media"); throw new Error("media discovery must not run"); }
    };
    const service = new AutonomousCycleService(
      candidates, execution, undefined, "test:idle-cycle",
      optimization as never, exploration as never, media as never
    );

    const result = await service.runOnce();

    assert.ok(result);
    assert.equal(result.candidateCount, 0);
    assert.deepEqual(result.execution, {
      selected: [], rejected: [], audit: [], outcomes: [], recoveredRunCount: 0
    });
    assert.deepEqual(calls, ["load-candidates"]);
  });

  it("idles when catalog products have no executable affiliate offers", async () => {
    const calls: string[] = [];
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        calls.push("load-candidates");
        return [{ product: { id: "product-without-link" } as never, offers: [] }];
      }
    };
    const execution = {
      async previewSelection() { calls.push("preview"); throw new Error("preview must not run"); },
      async runOnce() { calls.push("execution"); throw new Error("execution must not run"); }
    } as unknown as AutonomousExecutionService;
    const optimization = { async run() { calls.push("optimization"); throw new Error("optimization must not run"); } };
    const service = new AutonomousCycleService(
      candidates, execution, undefined, "test:no-executable-offers",
      optimization as never
    );

    const result = await service.runOnce();

    assert.ok(result);
    assert.equal(result.candidateCount, 1);
    assert.deepEqual(calls, ["load-candidates"]);
  });

  it("loads candidates and delegates one execution pass", async () => {
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        return [
          { product: { id: "product-1" } as never, offers: [{} as never] },
          { product: { id: "product-2" } as never, offers: [{} as never] }
        ];
      }
    };
    const calls: unknown[] = [];
    const execution = {
      async runOnce(input: { candidates: unknown[]; requirePublishableMedia?: boolean; requireCommissionSignal?: boolean }) {
        calls.push(input);
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;

    const service = new AutonomousCycleService(candidates, execution);
    const result = await service.runOnce({ idempotencyNamespace: "cycle-test" });

    assert.ok(result);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.execution.outcomes.length, 0);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { candidates: unknown[] }).candidates.length, 2);
    assert.equal((calls[0] as { requirePublishableMedia?: boolean }).requirePublishableMedia, true);
    assert.equal((calls[0] as { requireCommissionSignal?: boolean }).requireCommissionSignal, true);
    assert.ok(new Date(result.completedAt).getTime() >= new Date(result.startedAt).getTime());
    assert.equal(service.skipReason, undefined);
  });


  it("applies the same mandatory safety gates to preview and execution", async () => {
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        return [{ product: { id: "product-preview" } as never, offers: [{} as never] }];
      }
    };
    const previewCalls: unknown[] = [];
    const execution = {
      async previewSelection(input: { candidates: unknown[]; requirePublishableMedia?: boolean; requireCommissionSignal?: boolean }) {
        previewCalls.push(input);
        return { selected: [], rejected: [], audit: [] };
      },
      async runOnce(input: { candidates: unknown[]; requirePublishableMedia?: boolean; requireCommissionSignal?: boolean }) {
        previewCalls.push(input);
        return { selected: [], rejected: [], audit: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);

    // Even forged caller-provided IDs must not bypass the persisted media/rights lookup.
    const untrustedIds = ["product-preview"];
    await service.previewSelection({
      publishableMediaProductIds: untrustedIds,
      publishableVideoProductIds: untrustedIds
    });
    await service.runOnce({
      publishableMediaProductIds: untrustedIds,
      publishableVideoProductIds: untrustedIds
    });

    assert.equal(previewCalls.length, 2);
    for (const call of previewCalls) {
      assert.equal((call as { requirePublishableMedia?: boolean }).requirePublishableMedia, true);
      assert.equal((call as { requireCommissionSignal?: boolean }).requireCommissionSignal, true);
      assert.deepEqual((call as { publishableMediaProductIds?: string[] }).publishableMediaProductIds, []);
      assert.deepEqual((call as { publishableVideoProductIds?: string[] }).publishableVideoProductIds, []);
    }
  });

  it("requires publishable media for draft-only cycles while keeping publication disabled", async () => {
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: { id: "draft-product" } as never, offers: [{} as never] }]; }
    };
    const calls: Array<{ type: string; publicationEnabled?: boolean; scheduledAt?: string; requirePublishableMedia?: boolean }> = [];
    const execution = {
      async previewSelection(input: { publicationEnabled?: boolean; requirePublishableMedia?: boolean }) {
        calls.push({ type: "preview", publicationEnabled: input.publicationEnabled, requirePublishableMedia: input.requirePublishableMedia });
        return { selected: [], rejected: [], audit: [] };
      },
      async runOnce(input: { publicationEnabled?: boolean; scheduledAt?: string; requirePublishableMedia?: boolean }) {
        calls.push({ type: "run", publicationEnabled: input.publicationEnabled, scheduledAt: input.scheduledAt, requirePublishableMedia: input.requirePublishableMedia });
        return { selected: [], rejected: [], audit: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);

    await service.previewSelection({ publicationEnabled: false });
    const result = await service.runOnce({ publicationEnabled: false, publicationDelayMs: 60_000 });

    assert.ok(result);
    assert.equal(calls[0]?.requirePublishableMedia, true);
    assert.equal(calls[1]?.publicationEnabled, false);
    assert.equal(calls[1]?.scheduledAt, undefined);
    assert.equal(calls[1]?.requirePublishableMedia, true);
  });

  it("derives publication time from a configured delay", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return [{ product: { id: "explicit-schedule-product" } as never, offers: [{} as never] }]; } };
    let scheduledAt: string | undefined;
    const execution = {
      async runOnce(input: { scheduledAt?: string }) {
        scheduledAt = input.scheduledAt;
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);
    const before = Date.now();
    await service.runOnce({ publicationDelayMs: 5_000 });
    const after = Date.now();
    assert.ok(scheduledAt);
    const scheduledMs = Date.parse(scheduledAt);
    assert.ok(scheduledMs >= before + 4_500);
    assert.ok(scheduledMs <= after + 5_500);
  });

  it("rejects invalid publication delays", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    const execution = { async runOnce() { return { selected: [], rejected: [], outcomes: [] }; } } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);
    await assert.rejects(() => service.runOnce({ publicationDelayMs: -1 }), /finite non-negative/);
    await assert.rejects(() => service.runOnce({ publicationDelayMs: Number.NaN }), /finite non-negative/);
  });

  it("preserves an explicit publication time over a configured delay", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    let scheduledAt: string | undefined;
    const execution = {
      async runOnce(input: { scheduledAt?: string }) { scheduledAt = input.scheduledAt; return { selected: [], rejected: [], outcomes: [] }; }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);
    await service.runOnce({ scheduledAt: "2026-10-01T10:00:00.000Z", publicationDelayMs: 60_000 });
    assert.equal(scheduledAt, "2026-10-01T10:00:00.000Z");
  });

  it("prevents overlapping cycles and releases the guard after completion", async () => {
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: { id: "product-1" } as never, offers: [{} as never] }]; }
    };
    const releases: Array<() => void> = [];
    let callCount = 0;
    let resolveSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });
    const execution = {
      runOnce: () => {
        callCount += 1;
        if (callCount === 2) resolveSecondStarted();
        return new Promise<{ selected: never[]; rejected: never[]; outcomes: never[] }>((resolve) => {
          releases.push(() => resolve({ selected: [], rejected: [], outcomes: [] }));
        });
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);
    const first = service.runOnce();
    const overlapping = await service.runOnce();
    assert.equal(overlapping, undefined);
    assert.equal(service.skipReason, "lock_busy");
    releases[0]();
    assert.ok(await first);
    const second = service.runOnce();
    await secondStarted;
    releases[1]();
    assert.ok(await second);
  });

  it("does not enter a cycle when a shared lock is already held", async () => {
    let executionCalls = 0;
    const lock: AutonomousCycleLock = {
      async tryAcquire() { return false; },
      async release() { throw new Error("release must not be called without acquisition"); }
    };
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    const execution = {
      async runOnce() { executionCalls += 1; return { selected: [], rejected: [], outcomes: [] }; }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution, lock);
    const result = await service.runOnce();
    assert.equal(result, undefined);
    assert.equal(service.skipReason, "lock_busy");
    assert.equal(executionCalls, 0);
  });

  it("releases the shared lock after a successful cycle", async () => {
    let acquired = false;
    let released = false;
    const lock: AutonomousCycleLock = {
      async tryAcquire(key) { assert.equal(key, "shared-cycle"); acquired = true; return true; },
      async release(key) { assert.equal(key, "shared-cycle"); released = true; }
    };
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    const execution = { async runOnce() { return { selected: [], rejected: [], outcomes: [] }; } } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution, lock, "shared-cycle");
    assert.ok(await service.runOnce());
    assert.equal(acquired, true);
    assert.equal(released, true);
  });

  it("releases the guard when candidate loading fails", async () => {
    let attempts = 0;
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() { attempts += 1; if (attempts === 1) throw new Error("catalog unavailable"); return []; }
    };
    const execution = { async runOnce() { return { selected: [], rejected: [], outcomes: [] }; } } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);
    await assert.rejects(() => service.runOnce(), /catalog unavailable/);
    const second = await service.runOnce();
    assert.ok(second);
    assert.equal(second.candidateCount, 0);
  });

  it("discovers candidates within the media score lift band without lowering final selection thresholds", async () => {
    const product = { id: "near-threshold", marketplaceId: "market-1" };
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: product as never, offers: [{} as never] }]; }
    };
    const previews: Array<{
      policy?: { minimumScore?: number; minimumDataConfidence?: number };
      policiesByMarketplace?: Record<string, { minimumScore?: number; minimumDataConfidence?: number }>;
      mediaReadinessScores?: Record<string, number>;
      requirePublishableMedia?: boolean;
    }> = [];
    let finalInput: {
      policy?: { minimumScore?: number; minimumDataConfidence?: number };
      policiesByMarketplace?: Record<string, { minimumScore?: number; minimumDataConfidence?: number }>;
      mediaReadinessScores?: Record<string, number>;
    } | undefined;
    const execution = {
      async previewSelection(input: (typeof previews)[number]) {
        previews.push(input);
        return {
          selected: [{ product: product as never, offerId: "offer-1", score: input.requirePublishableMedia ? 63 : 58 }],
          rejected: [],
          audit: []
        };
      },
      async runOnce(input: NonNullable<typeof finalInput>) {
        finalInput = input;
        return { selected: [], rejected: [], audit: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    let discoveryCount = 0;
    const discovery = {
      async discover() {
        discoveryCount += 1;
        return { productId: product.id, pageFetched: false, hasVideo: true, stored: [], skipped: [] };
      },
      async listPublishableMediaProductIds() { return [product.id]; },
      async listVideoProductIds() { return [product.id]; },
      async listPublishableVideoProductIds() { return [product.id]; },
      async listMediaReadinessScores() { return { [product.id]: 100 }; },
      async generatePromoVideo() { throw new Error("A stored publishable video must not be rendered again."); }
    };
    const service = new AutonomousCycleService(candidates, execution, undefined, undefined, undefined, undefined, discovery as never);

    await service.runOnce({
      publicationEnabled: false,
      policy: { minimumScore: 60, minimumDataConfidence: 35, maximumResults: 10 },
      policiesByMarketplace: { "market-1": { minimumScore: 62, minimumDataConfidence: 45 } }
    });

    assert.equal(discoveryCount, 1);
    assert.equal(previews.length, 2);
    assert.equal(previews[0]?.policy?.minimumScore, 55);
    assert.equal(previews[0]?.policy?.minimumDataConfidence, 25);
    assert.equal(previews[0]?.policiesByMarketplace?.["market-1"]?.minimumScore, 57);
    assert.equal(previews[0]?.policiesByMarketplace?.["market-1"]?.minimumDataConfidence, 35);
    assert.equal(previews[1]?.policy?.minimumScore, 60);
    assert.equal(previews[1]?.policy?.minimumDataConfidence, 35);
    assert.equal(previews[1]?.policiesByMarketplace?.["market-1"]?.minimumScore, 62);
    assert.equal(previews[1]?.policiesByMarketplace?.["market-1"]?.minimumDataConfidence, 45);
    assert.deepEqual(previews[1]?.mediaReadinessScores, { [product.id]: 100 });
    assert.equal(finalInput?.policy?.minimumScore, 60);
    assert.equal(finalInput?.policy?.minimumDataConfidence, 35);
    assert.equal(finalInput?.policiesByMarketplace?.["market-1"]?.minimumScore, 62);
    assert.equal(finalInput?.policiesByMarketplace?.["market-1"]?.minimumDataConfidence, 45);
    assert.deepEqual(finalInput?.mediaReadinessScores, { [product.id]: 100 });
  });


  it("persists preliminary eligibility separately from final media-gated selection", async () => {
    const product = { id: "pre-media-product", marketplaceId: "market-1" };
    const rejectedProduct = { id: "rejected-pre-media-product", marketplaceId: "market-1" };
    const provider: AutonomousCandidateProvider = {
      async listCandidates() { return [{ product: product as never, offers: [{} as never] }, { product: rejectedProduct as never, offers: [] }]; }
    };
    const saved: Array<Record<string, unknown>> = [];
    const execution = {
      async previewSelection(input: { requirePublishableMedia?: boolean }) {
        return input.requirePublishableMedia
          ? { selected: [], rejected: [], audit: [] }
          : {
              selected: [{ product: product as never, offerId: "offer-1", score: 76, reasons: ["Eligible before media"] }],
              rejected: [{ productId: rejectedProduct.id, score: 42, reasons: ["Below preliminary score"] }],
              audit: [
                { auditId: "audit-1", productId: product.id, marketplaceId: product.marketplaceId, selected: true, score: 76, policy: { minimumScore: 55, minimumDataConfidence: 25 }, reasons: ["Selected"] },
                { auditId: "audit-2", productId: rejectedProduct.id, marketplaceId: rejectedProduct.marketplaceId, selected: false, score: 42, policy: { minimumScore: 55, minimumDataConfidence: 25 }, reasons: ["Below preliminary score"] }
              ]
            };
      },
      async runOnce() { return { selected: [], rejected: [], audit: [], outcomes: [] }; }
    } as unknown as AutonomousExecutionService;
    const discovery = {
      async discover() { return { productId: product.id, pageFetched: false, hasVideo: false, stored: [], skipped: [] }; },
      async listPublishableMediaProductIds() { return []; },
      async listPublishableVideoProductIds() { return []; },
      async listMediaReadinessScores() { return { [product.id]: 0 }; },
      async listVideoProductIds() { return []; }
    };
    const evidenceRepository = {
      async saveMany(records: Array<Record<string, unknown>>) { saved.push(...records); },
      async listLatestByProduct() { return []; }
    };
    const service = new AutonomousCycleService(provider, execution, undefined, undefined, undefined, undefined, discovery as never, evidenceRepository as never);
    await service.runOnce({ publicationEnabled: false, idempotencyNamespace: "media-evidence-test" });

    assert.equal(saved.length, 2);
    assert.equal(saved[0]?.productId, product.id);
    assert.equal(saved[0]?.marketplaceId, product.marketplaceId);
    assert.equal(saved[0]?.offerId, "offer-1");
    assert.equal(saved[0]?.score, 76);
    assert.equal((saved[0]?.policy as Record<string, unknown>).requirePublishableMedia, false);
    assert.equal((saved[0]?.policy as Record<string, unknown>).requirePublishableVideo, false);
    assert.equal(saved[0]?.eligible, true);
    assert.equal((saved[0]?.policy as Record<string, unknown>).minimumScore, 55);
    assert.equal((saved[0]?.policy as Record<string, unknown>).minimumDataConfidence, 25);
    assert.ok(typeof saved[0]?.cycleId === "string");
    assert.ok(typeof saved[0]?.createdAt === "string");
    const rejectedEvidence = saved.find((record) => record.productId === rejectedProduct.id);
    assert.equal(rejectedEvidence?.eligible, false);
    assert.equal(rejectedEvidence?.offerId, undefined);
  });

});
