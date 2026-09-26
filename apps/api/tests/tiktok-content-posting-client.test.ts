import assert from "node:assert/strict";
import test from "node:test";
import { TikTokContentPostingClient } from "../src/domain/tiktok-content-posting-client.js";

const account = {
  id: "account-1",
  platform: "tiktok",
  accountReference: "open-123",
  status: "active" as const,
  connection: {
    tiktokPrivacyLevel: "SELF_ONLY",
    tiktokPublishingConsentAt: "2026-09-26T06:00:00.000Z"
  },
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

const content = {
  id: "content-1",
  platform: "tiktok" as const,
  contentType: "affiliate-promotion",
  caption: "Test affiliate content",
  status: "scheduled" as const,
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

const operation = {
  id: "operation-1",
  jobId: "job-1",
  contentId: "content-1",
  provider: "tiktok-content-posting",
  providerOperationId: "publish-1",
  status: "accepted" as const,
  attemptCount: 1,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

test("TikTok client queries creator info and initializes a URL publication", async () => {
  const calls: string[] = [];
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
      if (String(input).includes("creator_info")) {
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { publish_id: "publish-1" }, error: { code: "ok" } }), { status: 200 });
    }
  });

  const result = await client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-1" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-1" });
  assert.equal(calls.length, 2);
});

test("TikTok client fails closed without explicit consent", async () => {
  const noConsent = { ...account, connection: { tiktokPrivacyLevel: "SELF_ONLY", tiktokPublishingConsentAt: undefined } };
  let called = false;
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); }
  });
  await assert.rejects(() => client.publish({ content, account: noConsent, mediaAssets: [asset], idempotencyKey: "idem-1" }), /explicit creator consent/i);
  assert.equal(called, false);
});

test("TikTok client reconciles published status", async () => {
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({ data: { status: "PUBLISH_COMPLETE", post_id: "post-123" }, error: { code: "ok" } }), { status: 200 })
  });
  const result = await client.checkPublication({ content, account, mediaAssets: [asset], operation });
  assert.deepEqual(result, { status: "published", externalPostId: "post-123" });
});
