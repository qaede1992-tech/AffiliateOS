import assert from "node:assert/strict";
import test from "node:test";
import {
  getProductMediaDiscoveryStrategyVersion,
  isReviewableProductMediaCandidate,
  mergeWikimediaVideoFallbackCandidates,
  shouldSearchWikimediaVideoFallback
} from "../src/domain/product-media-discovery-runner.js";
import type { ProductMediaCatalogCandidate } from "../src/domain/product-media-catalog-search.js";

const candidate = (
  overrides: Partial<ProductMediaCatalogCandidate> & Pick<ProductMediaCatalogCandidate, "provider" | "title" | "mediaKind" | "landingPageUrl">
): ProductMediaCatalogCandidate => ({
  provider: overrides.provider,
  title: overrides.title,
  mediaKind: overrides.mediaKind,
  imageUrl: overrides.mediaKind === "image" ? "https://upload.wikimedia.org/example.jpg" : null,
  videoUrl: overrides.mediaKind === "video" ? "https://upload.wikimedia.org/example.webm" : null,
  landingPageUrl: overrides.landingPageUrl,
  creator: null,
  creatorUrl: null,
  license: "by-sa",
  licenseVersion: "4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourcePublisher: overrides.provider === "openverse" ? "Openverse" : "Wikimedia Commons",
  identityScore: 85,
  identityStatus: "review_required",
  identityReasons: ["Identity requires manual review."],
  rightsStatus: "unverified",
  ...overrides
});

test("searches Wikimedia for a video when Openverse found images but no video", () => {
  const images = [candidate({
    provider: "openverse",
    title: "Model X product photograph",
    mediaKind: "image",
    landingPageUrl: "https://openverse.example/image/1"
  })];

  assert.equal(shouldSearchWikimediaVideoFallback(images, { model: "Model X" }), true);
});

test("does not search Wikimedia when a video candidate already exists", () => {
  const candidates = [candidate({
    provider: "openverse",
    title: "Model X video",
    mediaKind: "video",
    landingPageUrl: "https://openverse.example/video/1"
  })];

  assert.equal(shouldSearchWikimediaVideoFallback(candidates, { sku: "SKU-123" }), false);
});

test("searches Wikimedia after empty Openverse results only when a category signal exists", () => {
  assert.equal(shouldSearchWikimediaVideoFallback([], { category: "Peralatan Dapur", model: " ", sku: null }), true);
  assert.equal(shouldSearchWikimediaVideoFallback([], { model: " ", sku: null }), false);
});

test("searches Wikimedia after empty Openverse results when a recognized product type is present in the name", () => {
  assert.equal(
    shouldSearchWikimediaVideoFallback([], { name: "GSM Crisper Tray Cooper Carbon Steel Ceramic" }),
    true
  );
});

test("versions only the recognized-name discovery strategy to invalidate its stale cooldown", () => {
  assert.equal(getProductMediaDiscoveryStrategyVersion("GSM Crisper Tray Cooper Carbon Steel Ceramic"), "wikimedia-name-category-v3");
  assert.equal(getProductMediaDiscoveryStrategyVersion("GSM Premium Collection Cooper Edition"), null);
  assert.equal(getProductMediaDiscoveryStrategyVersion(null), null);
});

test("keeps low-score category-only leads out of the review queue", () => {
  assert.equal(isReviewableProductMediaCandidate({ identityScore: 20, identityStatus: "review_required" }), false);
  assert.equal(isReviewableProductMediaCandidate({ identityScore: 49, identityStatus: "review_required" }), false);
  assert.equal(isReviewableProductMediaCandidate({ identityScore: 65, identityStatus: "review_required" }), true);
  assert.equal(isReviewableProductMediaCandidate({ identityScore: 100, identityStatus: "rejected" }), false);
});

test("does not broaden Wikimedia fallback for an unclassified generic product name", () => {
  assert.equal(
    shouldSearchWikimediaVideoFallback([], { name: "GSM Premium Collection Cooper Edition" }),
    false
  );
});

test("does not broaden Wikimedia fallback when Openverse already found an image and no structured identifier exists", () => {
  const images = [candidate({
    provider: "openverse",
    title: "Crisper tray category image",
    mediaKind: "image",
    landingPageUrl: "https://openverse.example/image/category"
  })];

  assert.equal(shouldSearchWikimediaVideoFallback(images, { model: null, sku: null }), false);
});

test("merges provider candidates, removes duplicate landing pages, and prioritizes video", () => {
  const openverseImage = candidate({
    provider: "openverse",
    title: "Model X still image",
    mediaKind: "image",
    landingPageUrl: "https://commons.wikimedia.org/wiki/File:shared.jpg"
  });
  const fallbackVideo = candidate({
    provider: "wikimedia_commons",
    title: "Model X demonstration",
    mediaKind: "video",
    landingPageUrl: "https://commons.wikimedia.org/wiki/File:demo.webm"
  });
  const duplicate = candidate({
    provider: "wikimedia_commons",
    title: "Duplicate of existing image",
    mediaKind: "image",
    landingPageUrl: openverseImage.landingPageUrl
  });

  const merged = mergeWikimediaVideoFallbackCandidates([openverseImage], [duplicate, fallbackVideo], 10);

  assert.deepEqual(merged.map((item) => item.landingPageUrl), [
    fallbackVideo.landingPageUrl,
    openverseImage.landingPageUrl
  ]);
  assert.equal(merged[1]?.provider, "openverse");
});

test("respects the configured merged candidate limit", () => {
  const primary = Array.from({ length: 3 }, (_, index) => candidate({
    provider: "openverse",
    title: `Model X image ${index}`,
    mediaKind: "image",
    landingPageUrl: `https://openverse.example/image/${index}`
  }));
  const fallback = [candidate({
    provider: "wikimedia_commons",
    title: "Model X video",
    mediaKind: "video",
    landingPageUrl: "https://commons.wikimedia.org/wiki/File:video.webm"
  })];

  assert.equal(mergeWikimediaVideoFallbackCandidates(primary, fallback, 2).length, 2);
});
