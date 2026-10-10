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
  byteSize: 4 * 1024 * 1024,
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

test("TikTok client uses FILE_UPLOAD by default and uploads the media sequentially", async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: Uint8Array }> = [];
  const video = new Uint8Array(asset.byteSize).fill(7);
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body instanceof Uint8Array ? init.body : undefined });
      if (url.includes("creator_info")) {
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }), { status: 200 });
      }
      if (url.includes("/video/init/")) {
        assert.match(String(init?.body), /"source":"FILE_UPLOAD"/);
        assert.match(String(init?.body), /"video_size":4194304/);
        return new Response(JSON.stringify({ data: { publish_id: "publish-1", upload_url: "https://upload.example.test/video" }, error: { code: "ok" } }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(video, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(video.byteLength) } });
      }
      assert.equal(url, "https://upload.example.test/video");
      assert.equal(init?.method, "PUT");
      assert.equal(headers.get("content-range"), "bytes 0-4194303/4194304");
      assert.equal(headers.get("content-length"), "4194304");
      return new Response(null, { status: 201 });
    }
  });

  const result = await client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-1" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-1" });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "GET", "PUT"]);
  assert.equal(calls[3]?.body?.byteLength, video.byteLength);
});

test("TikTok client retains PULL_FROM_URL as an explicit compatibility mode", async () => {
  const calls: string[] = [];
  const client = new TikTokContentPostingClient({
    mediaTransferMode: "PULL_FROM_URL",
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
      if (String(input).includes("creator_info")) {
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { publish_id: "publish-pull-1" }, error: { code: "ok" } }), { status: 200 });
    }
  });

  const result = await client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-pull" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-pull-1" });
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
    fetchImpl: async () => new Response(JSON.stringify({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [123456789] }, error: { code: "ok" } }), { status: 200 })
  });
  const result = await client.checkPublication({ content, account, mediaAssets: [asset], operation });
  assert.deepEqual(result, { status: "published", externalPostId: "123456789" });
});


test("TikTok client publishes an image through the photo Direct Post API", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const image = {
    ...asset,
    id: "asset-image-1",
    kind: "image" as const,
    reference: "https://media.example.test/product.jpg",
    mimeType: "image/jpeg",
    byteSize: undefined
  };

  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("creator_info")) {
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }), { status: 200 });
      }
      assert.equal(url, "https://open.tiktokapis.com/v2/post/publish/content/init/");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.media_type, "PHOTO");
      assert.equal(body.post_mode, "DIRECT_POST");
      assert.deepEqual(body.source_info, {
        source: "PULL_FROM_URL",
        photo_images: [image.reference],
        photo_cover_index: 0
      });
      assert.equal(body.post_info.privacy_level, "SELF_ONLY");
      return new Response(JSON.stringify({ data: { publish_id: "photo-publish-1" }, error: { code: "ok" } }), { status: 200 });
    }
  });

  const result = await client.publish({ content, account, mediaAssets: [image], idempotencyKey: "idem-photo-1" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "photo-publish-1" });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
});


test("TikTok creator interaction restrictions override account preferences", async () => {
  let publishBody: Record<string, unknown> | undefined;
  const client = new TikTokContentPostingClient({
    mediaTransferMode: "PULL_FROM_URL",
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) {
        return new Response(JSON.stringify({
          data: {
            privacy_level_options: ["SELF_ONLY"],
            comment_disabled: true,
            duet_disabled: true,
            stitch_disabled: true
          },
          error: { code: "ok" }
        }), { status: 200 });
      }
      publishBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { publish_id: "publish-restricted-1" }, error: { code: "ok" } }), { status: 200 });
    }
  });

  const accountWithInteractionsEnabled = {
    ...account,
    connection: {
      ...account.connection,
      tiktokDisableComment: false,
      tiktokDisableDuet: false,
      tiktokDisableStitch: false
    }
  };
  const result = await client.publish({
    content,
    account: accountWithInteractionsEnabled,
    mediaAssets: [asset],
    idempotencyKey: "idem-restricted-1"
  });

  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-restricted-1" });
  const postInfo = publishBody?.post_info as Record<string, unknown>;
  assert.equal(postInfo.disable_comment, true);
  assert.equal(postInfo.disable_duet, true);
  assert.equal(postInfo.disable_stitch, true);
});
