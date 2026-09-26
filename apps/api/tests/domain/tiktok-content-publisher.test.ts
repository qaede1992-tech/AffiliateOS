import assert from "node:assert/strict";
import test from "node:test";
import { TikTokContentPublisher } from "../../src/domain/tiktok-content-publisher.js";

const client = {
  async publish() { return { status: "accepted" as const, providerOperationId: "publish-1" }; },
  async checkPublication() { return { status: "processing" as const }; }
};

const contentBase = {
  id: "content-1",
  platform: "tiktok" as const,
  contentType: "affiliate-promotion",
  status: "scheduled" as const,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

test("TikTok publisher rejects scheduled content without media asset ids", () => {
  const publisher = new TikTokContentPublisher(client);
  assert.equal(publisher.supportsContent(contentBase), false);
});

test("TikTok publisher accepts content with media asset ids at distribution time", () => {
  const publisher = new TikTokContentPublisher(client);
  assert.equal(publisher.supportsContent({ ...contentBase, mediaAssetIds: ["asset-1"] }), true);
});

test("TikTok publisher rejects execution when the resolved media is not a video", async () => {
  const publisher = new TikTokContentPublisher(client);
  await assert.rejects(
    () => publisher.publish({
      content: { ...contentBase, mediaAssetIds: ["asset-1"] },
      account: {} as never,
      mediaAssets: [{ id: "asset-1", contentId: "content-1", kind: "image", source: "url", reference: "https://example.test/image.jpg", createdAt: contentBase.createdAt, updatedAt: contentBase.updatedAt }],
      idempotencyKey: "idem-1"
    }),
    /video media asset/i
  );
});
