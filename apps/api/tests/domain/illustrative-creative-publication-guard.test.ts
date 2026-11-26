import assert from "node:assert/strict";
import test from "node:test";
import type { Content } from "@affiliateos/shared";
import type { MediaAsset } from "../../src/domain/media-asset.js";
import { hashIllustrativeCreativeProvenanceSnapshot, IllustrativeCreativePublicationGuard } from "../../src/domain/illustrative-creative-publication-guard.js";
import type { IllustrativeCreativeRecord } from "../../src/domain/illustrative-media-delivery.js";

const productId = "33333333-3333-4333-8333-333333333333";
const offerId = "44444444-4444-4444-8444-444444444444";
const contentId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const creativeId = "55555555-5555-4555-8555-555555555555";
const digest = "a".repeat(64);
const now = new Date("2026-11-24T12:00:00.000Z");

function fixture(overrides: {
  content?: Partial<Content>;
  creative?: Partial<IllustrativeCreativeRecord>;
  policyEnabled?: boolean;
  productStatus?: string;
  offerStatus?: string;
  offerAvailability?: string;
  eligibility?: { eligible: boolean; offerId?: string; createdAt?: string };
  fileValid?: boolean;
} = {}) {
  const content: Content = {
    id: contentId, productId, campaignId: "campaign-1", platform: "instagram",
    contentType: "affiliate-promotion", status: "scheduled", mediaAssetIds: [mediaId],
    scheduledAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
    ...overrides.content
  };
  const storageKey = `${creativeId}-${digest}.mp4`;
  const creative: IllustrativeCreativeRecord = {
    id: creativeId, mediaAssetId: mediaId, contentId, platform: "instagram", sha256: digest,
    mimeType: "video/mp4", byteSize: 128, disclosureEmbedded: true, reviewStatus: "approved",
    storageBackend: "local_volume", storageKey, productId, affiliateOfferId: offerId,
    rendererVersion: "renderer-1", templateVersion: "template-1",
    productSnapshot: { productId, name: "Demo Product", priceCents: 10000, currency: "IDR", capturedAt: now.toISOString() },
    widthPx: 720, heightPx: 1280, durationMs: 12000,
    reviewedBy: "admin-1", reviewedAt: now.toISOString(), reviewReason: "Original AI creative checked.",
    ...overrides.creative
  };
  const media: MediaAsset = {
    id: mediaId, contentId, kind: "video", source: "object-storage",
    reference: `affiliate-media/content/${contentId}/${storageKey}`,
    mimeType: "video/mp4", byteSize: 128, widthPx: 720, heightPx: 1280, durationSeconds: 12,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  let fileReads = 0;
  const deps = {
    creatives: {
      findByMediaAssetId: async (id: string) => id === mediaId ? creative : undefined,
      getPolicy: async () => overrides.policyEnabled === false
        ? { platform: "instagram" as const, enabled: false, policyVersion: "policy-v1", approvedBy: "admin-1", approvedAt: now.toISOString(), terms: {} }
        : { platform: "instagram" as const, enabled: true, policyVersion: "policy-v1", approvedBy: "admin-1", approvedAt: now.toISOString(), terms: { allowedRendererVersions: ["renderer-1"], allowedTemplateVersions: ["template-1"] } }
    },
    files: { get: async () => {
      fileReads += 1;
      if (overrides.fileValid === false) throw new Error("integrity mismatch");
      return new Uint8Array([1, 2, 3]);
    } },
    products: { findById: async () => ({
      id: productId, name: "Demo Product", priceCents: 10000, currency: "IDR",
      status: overrides.productStatus ?? "active"
    }) },
    offers: { findById: async () => ({
      id: offerId, productId, status: overrides.offerStatus ?? "active",
      availability: overrides.offerAvailability ?? "in_stock", affiliateLinkStatus: "active",
      affiliateUrl: "https://affiliate.example/offer", availabilityMetadata: { affiliateEligible: true }
    }) },
    campaignOffers: { listByCampaign: async () => [{ affiliateOfferId: offerId }] },
    trackingLinks: { listByCampaign: async () => [{
      status: "active", affiliateOfferId: offerId, destinationUrl: "https://affiliate.example/offer"
    }] },
    preMediaEligibility: { listLatestByProduct: async () => [{
      eligible: overrides.eligibility?.eligible ?? true,
      offerId: overrides.eligibility?.offerId ?? offerId,
      createdAt: overrides.eligibility?.createdAt ?? now.toISOString()
    }] }
  };
  const guard = new IllustrativeCreativePublicationGuard(deps as never);
  return { guard, content, media, get fileReads() { return fileReads; } };
}


test("captures reviewer, product, file, renderer, and policy provenance in a stable snapshot", async () => {
  const state = fixture();
  const snapshot = await state.guard.createProvenanceSnapshot([state.media], new Set([mediaId]));
  assert.ok(snapshot);
  assert.equal(snapshot.policy.policyVersion, "policy-v1");
  assert.equal(snapshot.policy.approvedBy, "admin-1");
  assert.equal(snapshot.creatives[0]?.reviewedBy, "admin-1");
  assert.equal(snapshot.creatives[0]?.reviewedAt, now.toISOString());
  assert.equal(snapshot.creatives[0]?.reviewReason, "Original AI creative checked.");
  assert.equal(snapshot.creatives[0]?.sha256, digest);
  assert.equal(hashIllustrativeCreativeProvenanceSnapshot(snapshot), hashIllustrativeCreativeProvenanceSnapshot(snapshot));
  assert.equal(await state.guard.createProvenanceSnapshot([state.media], new Set()), null);
});

test("refuses a provenance snapshot when any generated media ID has no creative record", async () => {
  const state = fixture();
  await assert.rejects(
    state.guard.createProvenanceSnapshot([state.media], new Set([mediaId, "99999999-9999-4999-8999-999999999999"])),
    /not every generated media ID has a persisted creative provenance record/
  );
});

test("allows only a fully approved, current, eligible Instagram illustrative creative", async () => {
  const state = fixture();
  const generated = await state.guard.validate({
    content: state.content, mediaAssets: [state.media], linkedProductIds: [productId], now
  });
  assert.deepEqual([...generated], [mediaId]);
});


test("rejects a generated media reference whose filename differs from the creative storage key before reading the file", async () => {
  const state = fixture();
  state.media.reference = `affiliate-media/content/${contentId}/${"66666666-6666-4666-8666-666666666666"}-${digest}.mp4`;
  await assert.rejects(state.guard.validate({
    content: state.content, mediaAssets: [state.media], linkedProductIds: [productId], now
  }), /reference filename does not match the creative storage key/);
  assert.equal(state.fileReads, 0);
});

test("does not classify media without a registered generated-creative provenance record as generated", async () => {
  const state = fixture();
  const generated = await state.guard.validate({
    content: state.content, mediaAssets: [], linkedProductIds: [productId], now
  });
  assert.equal(generated.size, 0);
});

test("fails closed when creative review, disclosure, or policy is not approved", async () => {
  for (const creative of [
    { reviewStatus: "pending" },
    { disclosureEmbedded: false }
  ]) {
    const state = fixture({ creative });
    await assert.rejects(state.guard.validate({
      content: state.content, mediaAssets: [state.media], linkedProductIds: [productId], now
    }), /ILLUSTRATIVE_CREATIVE_PUBLICATION_BLOCKED/);
  }
  const disabled = fixture({ policyEnabled: false });
  await assert.rejects(disabled.guard.validate({
    content: disabled.content, mediaAssets: [disabled.media], linkedProductIds: [productId], now
  }), /policy is disabled/);
});

test("fails closed for stale product facts, inactive products, or unlinked products", async () => {
  const stale = fixture({ creative: { productSnapshot: {
    productId, name: "Old Name", priceCents: 10000, currency: "IDR", capturedAt: now.toISOString()
  } } });
  await assert.rejects(stale.guard.validate({
    content: stale.content, mediaAssets: [stale.media], linkedProductIds: [productId], now
  }), /product facts are stale/);

  const inactive = fixture({ productStatus: "inactive" });
  await assert.rejects(inactive.guard.validate({
    content: inactive.content, mediaAssets: [inactive.media], linkedProductIds: [productId], now
  }), /missing or inactive/);

  const unlinked = fixture();
  await assert.rejects(unlinked.guard.validate({
    content: unlinked.content, mediaAssets: [unlinked.media], linkedProductIds: [], now
  }), /not linked/);
});

test("fails closed for inactive or out-of-stock offers and stale or mismatched eligibility evidence", async () => {
  for (const options of [
    { offerStatus: "inactive" },
    { offerAvailability: "out_of_stock" },
    { eligibility: { eligible: false } },
    { eligibility: { eligible: true, offerId: "66666666-6666-4666-8666-666666666666" } },
    { eligibility: { eligible: true, createdAt: "2026-11-01T00:00:00.000Z" } }
  ] as const) {
    const state = fixture(options);
    await assert.rejects(state.guard.validate({
      content: state.content, mediaAssets: [state.media], linkedProductIds: [productId], now
    }), /ILLUSTRATIVE_CREATIVE_PUBLICATION_BLOCKED/);
  }
});

test("fails closed when the local file is missing or its integrity check fails", async () => {
  const state = fixture({ fileValid: false });
  await assert.rejects(state.guard.validate({
    content: state.content, mediaAssets: [state.media], linkedProductIds: [productId], now
  }), /local creative file is missing or failed integrity verification/);
});

test("does not permit generated creative provenance on TikTok or non-promotional content", async () => {
  const wrongPlatform = fixture({ content: { platform: "tiktok" } });
  await assert.rejects(wrongPlatform.guard.validate({
    content: wrongPlatform.content, mediaAssets: [wrongPlatform.media], linkedProductIds: [productId], now
  }), /scheduled Instagram affiliate-promotion/);

  const wrongType = fixture({ content: { contentType: "story" } });
  await assert.rejects(wrongType.guard.validate({
    content: wrongType.content, mediaAssets: [wrongType.media], linkedProductIds: [productId], now
  }), /scheduled Instagram affiliate-promotion/);
});
