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
  it("accepts HTTPS media URLs", () => {
    assert.equal(isPublicMediaUrl(asset.reference), true);
    assert.doesNotThrow(() => validateMediaAsset(asset));
  });

  it("rejects non-HTTPS URL references", () => {
    assert.equal(isPublicMediaUrl("http://cdn.example.com/video.mp4"), false);
    assert.throws(() => validateMediaAsset({ ...asset, reference: "http://cdn.example.com/video.mp4" }), /HTTPS URL/);
  });

  it("rejects invalid byte sizes", () => {
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: -1 }), /byteSize/);
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: 1.5 }), /byteSize/);
  });

  it("supports object-storage references without treating them as public URLs", () => {
    assert.doesNotThrow(() => validateMediaAsset({ ...asset, source: "object-storage", reference: "media/content-1/video.mp4" }));
  });
});
