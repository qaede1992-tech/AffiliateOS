import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { ProductMediaAsset } from "../src/domain/product-media-ingestion.js";
import type { ProductMediaCandidateRecord } from "../src/domain/product-media-candidate.js";
import { ProductMediaCandidateImportError, ProductMediaCandidateImportService } from "../src/domain/product-media-candidate-import.js";

const productId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-11-04T03:00:00.000Z");

const product: Product = {
  id: productId, marketplaceId: "33333333-3333-4333-8333-333333333333",
  externalProductId: "item-1", name: "Sample product", priceCents: 1000,
  currency: "IDR", reviewCount: 10, soldCount: 20, productUrl: "https://shopee.co.id/product/1",
  status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString()
};

const candidate: ProductMediaCandidateRecord = {
  id: candidateId, productId, provider: "wikimedia_commons", candidateHash: "a".repeat(64),
  query: "sample product", title: "Sample image", imageUrl: "https://upload.wikimedia.org/sample.jpg",
  landingPageUrl: "https://commons.wikimedia.org/wiki/File:Sample.jpg", creator: "Creator",
  creatorUrl: "https://commons.wikimedia.org/wiki/User:Creator", license: "CC-BY-SA",
  licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourcePublisher: "Wikimedia Commons", identityScore: 90, identityStatus: "strong_match",
  identityReasons: ["Product identity matches"], reviewStatus: "approved", rightsStatus: "unverified",
  reviewedBy: "admin-1", reviewedAt: now.toISOString(), reviewReason: "Identity reviewed",
  createdAt: now.toISOString(), updatedAt: now.toISOString()
};

const offer: AffiliateOffer = {
  id: "44444444-4444-4444-8444-444444444444", productId,
  affiliateAccountId: "55555555-5555-4555-8555-555555555555",
  availability: "in_stock", availabilityMetadata: {}, affiliateUrl: "https://affiliate.example/link",
  affiliateLinkStatus: "active", status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString()
};

const asset: ProductMediaAsset = {
  id: "66666666-6666-4666-8666-666666666666", productId, kind: "image",
  bucket: "product-media", objectKey: `products/${productId}/sample.jpg`, mimeType: "image/jpeg",
  byteSize: 1024, width: 800, height: 600, sha256: "b".repeat(64),
  sourceUrl: candidate.imageUrl, sourcePublisher: candidate.sourcePublisher,
  sourceProvider: candidate.provider, sourceCandidateId: candidate.id,
  sourceLandingPageUrl: candidate.landingPageUrl, sourceTitle: candidate.title,
  sourceQuery: candidate.query, sourceCreator: candidate.creator, sourceCreatorUrl: candidate.creatorUrl,
  sourceLicense: candidate.license, sourceLicenseVersion: candidate.licenseVersion,
  sourceLicenseUrl: candidate.licenseUrl, rightsStatus: "unverified", rightsBasis: null,
  rightsEvidenceUrl: null, rightsVerifiedAt: null, createdAt: now.toISOString()
};

function makeService(overrides: {
  candidate?: ProductMediaCandidateRecord;
  decision?: { selected: boolean; createdAt: string; outcome?: { offerId?: string; status: "completed" | "failed"; campaignId?: string } };
  affiliateOffer?: AffiliateOffer;
  existingAsset?: ProductMediaAsset;
  product?: Product;
} = {}) {
  let ingestionCalls = 0;
  let existing = overrides.existingAsset;
  const service = new ProductMediaCandidateImportService({
    candidates: { findById: async () => overrides.candidate ?? candidate } as never,
    assets: {
      findBySourceCandidateId: async () => existing,
      findByProductAndHash: async () => undefined,
      listByProduct: async () => [],
      save: async (value: ProductMediaAsset) => value
    },
    ingestion: {
      ingest: async () => {
        ingestionCalls++;
        existing = asset;
        return { stored: [asset], skipped: [] };
      }
    } as never,
    audits: {
      list: async () => [{
        auditId: "77777777-7777-4777-8777-777777777777",
        cycleId: "cycle-1", productId, marketplaceId: product.marketplaceId,
        selected: overrides.decision?.selected ?? true, score: 80, policy: {}, reasons: [],
        createdAt: overrides.decision?.createdAt ?? now.toISOString(),
        outcome: overrides.decision?.outcome ?? {
          offerId: offer.id, status: "completed", campaignId: "88888888-8888-4888-8888-888888888888",
          observedAt: now.toISOString()
        }
      }]
    },
    listProducts: async () => [overrides.product ?? product],
    listAffiliateOffers: async () => [overrides.affiliateOffer ?? offer],
    now: () => now
  });
  return { service, ingestionCalls: () => ingestionCalls };
}

test("imports only an approved candidate for a recently selected active product", async () => {
  const { service, ingestionCalls } = makeService();
  const result = await service.importApprovedCandidate(productId, candidateId);
  assert.equal(ingestionCalls(), 1);
  assert.equal(result.asset.sourceCandidateId, candidateId);
  assert.equal(result.asset.rightsStatus, "unverified");
  assert.equal(result.alreadyImported, false);
});

test("rejects a candidate that has not been approved", async () => {
  const { service, ingestionCalls } = makeService({ candidate: { ...candidate, reviewStatus: "pending" } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "CANDIDATE_NOT_APPROVED");
  assert.equal(ingestionCalls(), 0);
});

test("rejects products without a recent positive selection", async () => {
  const { service, ingestionCalls } = makeService({ decision: { selected: false, createdAt: now.toISOString() } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "PRODUCT_NOT_RECENTLY_SELECTED");
  assert.equal(ingestionCalls(), 0);
});

test("rejects an inactive or unavailable affiliate offer", async () => {
  const { service, ingestionCalls } = makeService({ affiliateOffer: { ...offer, affiliateLinkStatus: "expired" } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "AFFILIATE_OFFER_UNAVAILABLE");
  assert.equal(ingestionCalls(), 0);
});

test("returns an existing source-linked asset without downloading it again", async () => {
  const { service, ingestionCalls } = makeService({ existingAsset: asset });
  const result = await service.importApprovedCandidate(productId, candidateId);
  assert.equal(result.alreadyImported, true);
  assert.equal(result.asset.id, asset.id);
  assert.equal(ingestionCalls(), 0);
});

test("rejects candidates whose rights were revoked", async () => {
  const { service, ingestionCalls } = makeService({ candidate: { ...candidate, rightsStatus: "revoked" } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "CANDIDATE_NOT_APPROVED");
  assert.equal(ingestionCalls(), 0);
});

test("rejects a product that is no longer active", async () => {
  const { service, ingestionCalls } = makeService({ product: { ...product, status: "inactive" } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "PRODUCT_NOT_ELIGIBLE");
  assert.equal(ingestionCalls(), 0);
});

test("rejects an expired autonomous selection decision", async () => {
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const { service, ingestionCalls } = makeService({ decision: { selected: true, createdAt: stale } });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "PRODUCT_NOT_RECENTLY_SELECTED");
  assert.equal(ingestionCalls(), 0);
});

test("rejects a selected decision whose execution outcome failed", async () => {
  const { service, ingestionCalls } = makeService({
    decision: { selected: true, createdAt: now.toISOString(), outcome: { offerId: offer.id, status: "failed" } }
  });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "PRODUCT_NOT_RECENTLY_SELECTED");
  assert.equal(ingestionCalls(), 0);
});

test("rejects a selected decision without a completed campaign outcome", async () => {
  const { service, ingestionCalls } = makeService({
    decision: { selected: true, createdAt: now.toISOString(), outcome: { offerId: offer.id, status: "completed" } }
  });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "PRODUCT_NOT_RECENTLY_SELECTED");
  assert.equal(ingestionCalls(), 0);
});

test("requires the currently usable offer to match the completed autonomous outcome", async () => {
  const { service, ingestionCalls } = makeService({
    decision: { selected: true, createdAt: now.toISOString(), outcome: { offerId: "99999999-9999-4999-8999-999999999999", status: "completed", campaignId: "88888888-8888-4888-8888-888888888888" } }
  });
  await assert.rejects(() => service.importApprovedCandidate(productId, candidateId),
    (error: unknown) => error instanceof ProductMediaCandidateImportError && error.code === "AFFILIATE_OFFER_UNAVAILABLE");
  assert.equal(ingestionCalls(), 0);
});
