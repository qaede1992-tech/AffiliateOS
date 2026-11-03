import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPublicMediaUrl, validateMediaAsset, type MediaAsset } from "../../src/domain/media-asset.js";

const asset: MediaAsset = {
  id: "asset-1",
  contentId: "content-1",
  kind: "video",
  source: "url",
  reference: "https://cdn.example.com/video.mp4",
  mimeType: "video/mp4",
  byteSize: 1024,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z"
};

describe("MediaAsset", () => {
  it("accepts credential-free HTTPS media URLs with a hostname", () => {
    assert.equal(isPublicMediaUrl(asset.reference), true);
    assert.doesNotThrow(() => validateMediaAsset(asset));
  });

  it("rejects non-HTTPS URL references", () => {
    assert.equal(isPublicMediaUrl("http://cdn.example.com/video.mp4"), false);
    assert.throws(() => validateMediaAsset({ ...asset, reference: "http://cdn.example.com/video.mp4" }), /credential-free public HTTPS URL/);
  });

  it("rejects URL references containing embedded credentials", () => {
    const reference = "https://user:password@cdn.example.com/video.mp4";
    assert.equal(isPublicMediaUrl(reference), false);
    assert.throws(() => validateMediaAsset({ ...asset, reference }), /credential-free public HTTPS URL/);
  });

  it("rejects IP literals and local-only hostnames", () => {
    for (const reference of [
      "https://127.0.0.1/video.mp4",
      "https://[::1]/video.mp4",
      "https://localhost/video.mp4",
      "https://media.local/video.mp4",
      "https://metadata.google.internal/video.mp4",
      "https://media/video.mp4"
    ]) {
      assert.equal(isPublicMediaUrl(reference), false, reference);
      assert.throws(() => validateMediaAsset({ ...asset, reference }), /credential-free public HTTPS URL/);
    }
  });

  it("rejects invalid byte sizes", () => {
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: -1 }), /byteSize/);
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: 1.5 }), /byteSize/);
  });

  it("supports object-storage references without treating them as public URLs", () => {
    assert.doesNotThrow(() => validateMediaAsset({ ...asset, source: "object-storage", reference: "media/content-1/video.mp4" }));
  });
});
