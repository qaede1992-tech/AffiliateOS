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
  it("accepts credential-free HTTPS media URLs on a public-looking hostname", () => {
    assert.equal(isPublicMediaUrl(asset.reference), true);
    assert.doesNotThrow(() => validateMediaAsset(asset));
  });

  it("rejects non-HTTPS URL references", () => {
    assert.equal(isPublicMediaUrl("http://cdn.example.com/video.mp4"), false);
    assert.throws(() => validateMediaAsset({ ...asset, reference: "http://cdn.example.com/video.mp4" }), /public HTTPS hostname/);
  });

  it("rejects embedded URL credentials", () => {
    assert.equal(isPublicMediaUrl("https://user:secret@cdn.example.com/video.mp4"), false);
    assert.throws(() => validateMediaAsset({ ...asset, reference: "https://user:secret@cdn.example.com/video.mp4" }), /public HTTPS hostname/);
  });

  it("rejects IP-literal hosts, including private, loopback, and public addresses", () => {
    for (const reference of [
      "https://127.0.0.1/video.mp4",
      "https://10.0.0.8/video.mp4",
      "https://169.254.169.254/latest/meta-data",
      "https://8.8.8.8/video.mp4",
      "https://[::1]/video.mp4",
      "https://[::ffff:127.0.0.1]/video.mp4"
    ]) {
      assert.equal(isPublicMediaUrl(reference), false, reference);
    }
  });

  it("rejects local and special-use hostnames", () => {
    for (const reference of [
      "https://localhost/video.mp4",
      "https://media.localhost/video.mp4",
      "https://printer.local/video.mp4",
      "https://metadata.internal/video.mp4",
      "https://router.home.arpa/video.mp4",
      "https://asset.test/video.mp4",
      "https://asset.example/video.mp4",
      "https://asset.invalid/video.mp4",
      "https://asset.onion/video.mp4",
      "https://metadata/video.mp4"
    ]) {
      assert.equal(isPublicMediaUrl(reference), false, reference);
    }
  });

  it("rejects malformed URL references", () => {
    assert.equal(isPublicMediaUrl("not a URL"), false);
    assert.equal(isPublicMediaUrl("https:///missing-host/video.mp4"), false);
  });

  it("rejects invalid byte sizes", () => {
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: -1 }), /byteSize/);
    assert.throws(() => validateMediaAsset({ ...asset, byteSize: 1.5 }), /byteSize/);
  });

  it("supports object-storage references without treating them as public URLs", () => {
    assert.doesNotThrow(() => validateMediaAsset({ ...asset, source: "object-storage", reference: "media/content-1/video.mp4" }));
  });
});
