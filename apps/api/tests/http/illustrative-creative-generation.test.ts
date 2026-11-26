import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import type { IllustrativeProductCreativeGenerationService } from "../../src/domain/illustrative-product-creative-generation.js";
import type { IllustrativeCreativeRecord } from "../../src/domain/illustrative-media-delivery.js";

const productId = "11111111-1111-4111-8111-111111111111";
const contentId = "22222222-2222-4222-8222-222222222222";
const creativeId = "33333333-3333-4333-8333-333333333333";
const creative: IllustrativeCreativeRecord = {
  id: creativeId, mediaAssetId: "44444444-4444-4444-8444-444444444444",
  contentId, productId, affiliateOfferId: "55555555-5555-4555-8555-555555555555",
  platform: "instagram", sha256: "a".repeat(64), mimeType: "video/mp4",
  byteSize: 1024, disclosureEmbedded: true, reviewStatus: "pending",
  storageBackend: "local_volume", storageKey: creativeId + "-" + "a".repeat(64) + ".mp4"
};

function makeApp(role: "admin" | "operator" | "viewer" = "admin") {
  const services = createInMemoryServices();
  let generateCalls = 0;
  let reviewCalls = 0;
  services.illustrativeCreativeGeneration = {
    async generate(input: { productId: string; contentId: string }) {
      generateCalls++;
      assert.deepEqual(input, { productId, contentId });
      return creative;
    }
  } as unknown as IllustrativeProductCreativeGenerationService;
  services.illustrativeCreativeReview = {
    async review(input) {
      reviewCalls++;
      assert.equal(input.actorId, "creative-review-test");
      return { ...creative, reviewStatus: input.status, reviewedBy: input.actorId, reviewReason: input.reason };
    },
    async listReviewAudits(id) {
      assert.equal(id, creativeId);
      return [{ id: "audit-1", creativeId: id, action: "approve", newStatus: "approved" }];
    }
  };
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "creative-review-test", role },
    rateLimit: { enabled: false, limit: 10, windowMs: 60_000 }
  });
  return { app, get generateCalls() { return generateCalls; }, get reviewCalls() { return reviewCalls; } };
}

test("admin can persist an eligible illustrative creative through the generation endpoint", async () => {
  const h = makeApp();
  try {
    const response = await h.app.inject({
      method: "POST", url: `/api/v1/products/${productId}/illustrative-creatives`,
      payload: { contentId }
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().reviewStatus, "pending");
    assert.equal(response.json().storageBackend, "local_volume");
    assert.equal(h.generateCalls, 1);
  } finally {
    await h.app.close();
  }
});

test("non-admin callers cannot generate or review illustrative creatives", async () => {
  const h = makeApp("operator");
  try {
    const generated = await h.app.inject({
      method: "POST", url: `/api/v1/products/${productId}/illustrative-creatives`,
      payload: { contentId }
    });
    const reviewed = await h.app.inject({
      method: "PATCH", url: `/api/v1/illustrative-creatives/${creativeId}/review`,
      payload: { status: "approved", reason: "Visual quality checked" }
    });
    assert.equal(generated.statusCode, 403);
    assert.equal(reviewed.statusCode, 403);
    assert.equal(h.generateCalls, 0);
    assert.equal(h.reviewCalls, 0);
  } finally {
    await h.app.close();
  }
});

test("admin review records a reason and exposes the immutable audit history", async () => {
  const h = makeApp();
  try {
    const reviewed = await h.app.inject({
      method: "PATCH", url: `/api/v1/illustrative-creatives/${creativeId}/review`,
      payload: { status: "approved", reason: "Visual quality checked" }
    });
    assert.equal(reviewed.statusCode, 200);
    assert.equal(reviewed.json().reviewStatus, "approved");
    const audits = await h.app.inject({
      method: "GET", url: `/api/v1/illustrative-creatives/${creativeId}/review-audits`
    });
    assert.equal(audits.statusCode, 200);
    assert.equal(audits.json().data[0].action, "approve");
    assert.equal(h.reviewCalls, 1);
  } finally {
    await h.app.close();
  }
});
