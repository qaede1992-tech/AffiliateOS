import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMediaReadiness, evaluateProductMediaAssetReadiness } from "../src/domain/media-readiness-evaluator.js";

test("TikTok photo passes when known format, size, and dimensions pass", () => {
  const result = evaluateMediaReadiness("tiktok", { id: "p1", kind: "image", mimeType: "image/jpeg", byteSize: 2_000_000, widthPx: 1080, heightPx: 1920 });
  assert.equal(result.status, "ready");
  assert.ok(result.checks.every((item) => item.status === "pass"));
});

test("TikTok photo exceeding the 1080p short-edge limit fails", () => {
  const result = evaluateMediaReadiness("tiktok", { id: "p-square", kind: "image", mimeType: "image/jpeg", byteSize: 2_000_000, widthPx: 1920, heightPx: 1920 });
  assert.equal(result.status, "not_ready");
});

test("TikTok photo with unsupported PNG format fails", () => {
  const result = evaluateMediaReadiness("tiktok", { id: "p2", kind: "image", mimeType: "image/png", byteSize: 2_000_000, widthPx: 1080, heightPx: 1920 });
  assert.equal(result.status, "not_ready");
});

test("TikTok video remains review-required while codec and frame rate are unknown", () => {
  const result = evaluateMediaReadiness("tiktok", { id: "v1", kind: "video", mimeType: "video/mp4", byteSize: 12_000_000, widthPx: 720, heightPx: 1280, durationSeconds: 12, hasAudio: false }, { tiktokMaxVideoPostDurationSec: 180 });
  assert.equal(result.status, "review_required");
  assert.ok(result.checks.some((item) => item.key === "codec" && item.status === "unknown"));
  assert.ok(result.checks.some((item) => item.key === "frame_rate" && item.status === "unknown"));
});

test("TikTok video exceeding the latest Creator Info limit fails", () => {
  const result = evaluateMediaReadiness("tiktok", { id: "v2", kind: "video", mimeType: "video/mp4", byteSize: 12_000_000, widthPx: 720, heightPx: 1280, durationSeconds: 181, hasAudio: false }, { tiktokMaxVideoPostDurationSec: 180 });
  assert.equal(result.status, "not_ready");
});

test("missing metadata is review-required, never assumed compatible", () => {
  const result = evaluateMediaReadiness("instagram", { id: "v3", kind: "video", mimeType: "video/mp4", byteSize: 10_000_000 });
  assert.equal(result.status, "review_required");
  assert.ok(result.checks.some((item) => item.key === "dimensions" && item.status === "unknown"));
  assert.ok(result.checks.some((item) => item.key === "duration" && item.status === "unknown"));
});

test("Instagram Reels known duration and size violations fail", () => {
  const result = evaluateMediaReadiness("instagram", { id: "v4", kind: "video", mimeType: "video/mp4", byteSize: 2 * 1024 * 1024 * 1024, widthPx: 1080, heightPx: 1920, durationSeconds: 901, hasAudio: true });
  assert.equal(result.status, "not_ready");
});


test("persisted product media metadata is adapted with duration converted from milliseconds", () => {
  const result = evaluateProductMediaAssetReadiness("tiktok", {
    id: "asset-1",
    productId: "product-1",
    kind: "video",
    bucket: "affiliate-media",
    objectKey: "products/product-1/video.mp4",
    mimeType: "video/mp4",
    byteSize: 12_000_000,
    width: 720,
    height: 1280,
    durationMs: 12_501,
    hasAudio: false,
    sha256: "a".repeat(64),
    sourceUrl: "https://media.example/video.mp4",
    sourcePublisher: null,
    rightsStatus: "unverified",
    rightsBasis: null,
    rightsEvidenceUrl: null,
    rightsVerifiedAt: null,
    createdAt: "2026-11-03T00:00:00.000Z"
  }, { tiktokMaxVideoPostDurationSec: 180 });

  assert.equal(result.status, "review_required");
  assert.equal(result.mediaAssetId, "asset-1");
  assert.ok(result.checks.some((item) => item.key === "creator_duration_limit" && item.status === "pass" && item.detail.includes("180")));
});
