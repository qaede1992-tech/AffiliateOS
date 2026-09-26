import assert from "node:assert/strict";
import test from "node:test";
import { InstagramContentPublisher } from "../src/domain/instagram-content-publisher.js";
import { TikTokContentPublisher } from "../src/domain/tiktok-content-publisher.js";

const content = {
  id: "content-1",
  platform: "tiktok" as const,
  contentType: "affiliate-promotion",
  status: "scheduled" as const,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};
const account = {
  id: "account-1",
  platform: "tiktok",
  accountReference: "account-ref",
  status: "active" as const,
  connection: { tiktokPrivacyLevel: "SELF_ONLY", tiktokPublishingConsentAt: "2026-09-26T06:00:00.000Z" },
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};
const asset = {
  id: "asset-1",
  contentId: "content-1",
  kind: "video" as const,
  source: "url" as const,
  reference: "https://media.example.test/video.mp4",
  mimeType: "video/mp4",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

test("TikTok and Instagram publishers are platform-isolated", () => {
  const client = {
    publish: async () => ({ status: "accepted" as const, providerOperationId: "op-1" }),
    checkPublication: async () => ({ status: "processing" as const })
  };
  assert.equal(new TikTokContentPublisher(client).supports("tiktok"), true);
  assert.equal(new TikTokContentPublisher(client).supports("instagram"), false);
  assert.equal(new InstagramContentPublisher(client).supports("instagram"), true);
  assert.equal(new InstagramContentPublisher(client).supports("tiktok"), false);
});

test("publishers fail closed when media is missing", async () => {
  const client = {
    publish: async () => ({ status: "accepted" as const, providerOperationId: "op-1" }),
    checkPublication: async () => ({ status: "processing" as const })
  };
  await assert.rejects(() => new TikTokContentPublisher(client).publish({
    content,
    account,
    idempotencyKey: "idempotency-1"
  }), /media asset/i);
});

test("publisher boundary passes only resolved media assets to the injected client", async () => {
  let received = 0;
  const client = {
    publish: async (input: { mediaAssets: typeof asset[] }) => {
      received = input.mediaAssets.length;
      return { status: "accepted" as const, providerOperationId: "op-1" };
    },
    checkPublication: async () => ({ status: "processing" as const })
  };
  const publisher = new TikTokContentPublisher(client);
  const result = await publisher.publish({
    content,
    account,
    mediaAssets: [asset],
    idempotencyKey: "idempotency-1"
  });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "op-1" });
  assert.equal(received, 1);
});
