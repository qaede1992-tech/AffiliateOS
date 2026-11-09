import assert from "node:assert/strict";
import test from "node:test";
import { TikTokContentPostingClient, TikTokProviderRequestError } from "../src/domain/tiktok-content-posting-client.js";

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
  reference: "https://media.example.com/video.mp4",
  mimeType: "video/mp4",
  byteSize: 4 * 1024 * 1024,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

const approval = {
  privacyLevel: "SELF_ONLY",
  disableComment: false,
  disableDuet: false,
  disableStitch: false,
  commercialDisclosureEnabled: false,
  brandOrganicToggle: false,
  brandContentToggle: false,
  musicUsageConfirmed: true,
  previewConfirmed: true
};


const createByteStream = (totalBytes: number): ReadableStream<Uint8Array> => {
  let remaining = totalBytes;
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(chunk.byteLength, remaining);
      controller.enqueue(chunk.subarray(0, length));
      remaining -= length;
    }
  });
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
    mediaFetchImpl: async (_url, init, maxBytes) => {
      assert.equal(init.method, "GET");
      assert.equal(maxBytes, asset.byteSize);
      return new Response(video, { status: 200, headers: { "content-length": String(video.byteLength) } });
    },
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
      assert.equal(url, "https://upload.example.test/video");
      assert.equal(init?.method, "PUT");
      assert.equal(headers.get("content-range"), "bytes 0-4194303/4194304");
      assert.equal(headers.get("content-length"), "4194304");
      return new Response(null, { status: 201 });
    }
  });

  const result = await client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-1" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-1" });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "PUT"]);
  assert.equal(calls[2]?.body?.byteLength, video.byteLength);
});

test("TikTok FILE_UPLOAD cancels its source stream when a provider chunk upload fails", async () => {
  const videoSize = 64 * 1024 * 1024 + 1;
  const firstChunkSize = Math.ceil(videoSize / 2);
  let sourceCancelled = false;
  let firstChunkSent = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!firstChunkSent) {
        firstChunkSent = true;
        controller.enqueue(new Uint8Array(firstChunkSize).fill(7));
      }
    },
    cancel() {
      sourceCancelled = true;
    }
  });
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async (_url, init, maxBytes) => {
      assert.equal(init.method, "GET");
      assert.equal(maxBytes, videoSize);
      return new Response(source, {
        status: 200,
        headers: { "content-length": String(videoSize) }
      });
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) {
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      }
      if (url.includes("/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "publish-cleanup-1", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      }
      assert.equal(init?.method, "PUT");
      return new Response("TikTok upload endpoint unavailable", { status: 502 });
    }
  });

  await assert.rejects(
    () => client.publish({ content, account, mediaAssets: [{ ...asset, byteSize: videoSize }], tiktokApproval: approval, idempotencyKey: "idem-cleanup-1" }),
    /TikTok upload endpoint unavailable/
  );
  assert.equal(sourceCancelled, true);
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

  const result = await client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-pull" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-pull-1" });
  assert.equal(calls.length, 2);
});

test("TikTok client fails closed without an approved publication payload", async () => {
  let called = false;
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); }
  });
  await assert.rejects(
    () => client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-no-approval" }),
    /approved publication payload/i
  );
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
    reference: "https://media.example.com/product.jpg",
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

  const result = await client.publish({ content, account, mediaAssets: [image], tiktokApproval: approval, idempotencyKey: "idem-photo-1" });
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
    tiktokApproval: approval,
    idempotencyKey: "idem-restricted-1"
  });

  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-restricted-1" });
  const postInfo = publishBody?.post_info as Record<string, unknown>;
  assert.equal(postInfo.disable_comment, true);
  assert.equal(postInfo.disable_duet, true);
  assert.equal(postInfo.disable_stitch, true);
});


test("TikTok client exposes normalized creator info for the approval screen", async () => {
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://open.tiktokapis.com/v2/post/publish/creator_info/query/");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
      return new Response(JSON.stringify({
        data: {
          creator_nickname: "Demo Creator",
          privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
          can_post_more: true
        }
      }), { status: 200 });
    }
  });

  assert.deepEqual(await client.getCreatorInfo(account), {
    creatorNickname: "Demo Creator",
    privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"],
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
    maxVideoPostDurationSec: 600,
    canPostMore: true
  });
});


test("TikTok client blocks publishing when creator cannot post more", async () => {
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => new Response(JSON.stringify({
      data: { privacy_level_options: ["SELF_ONLY"], can_post_more: false },
      error: { code: "ok" }
    }), { status: 200 })
  });
  await assert.rejects(
    () => client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-cap-1" }),
    /cannot publish more posts/i
  );
});

test("TikTok client blocks video without duration metadata when creator has a duration limit", async () => {
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({
      data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 },
      error: { code: "ok" }
    }), { status: 200 })
  });
  await assert.rejects(
    () => client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-duration-missing" }),
    /duration metadata/i
  );
});

test("TikTok client blocks video longer than the latest creator limit", async () => {
  const timedAsset = { ...asset, durationSeconds: 61 };
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({
      data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 },
      error: { code: "ok" }
    }), { status: 200 })
  });
  await assert.rejects(
    () => client.publish({ content, account, mediaAssets: [timedAsset], tiktokApproval: approval, idempotencyKey: "idem-duration-long" }),
    /exceeds the creator's current maximum/i
  );
});

test("TikTok client accepts video at the creator duration limit", async () => {
  const timedAsset = { ...asset, durationSeconds: 60 };
  const client = new TikTokContentPostingClient({
    mediaTransferMode: "PULL_FROM_URL",
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      if (String(input).includes("creator_info")) {
        return new Response(JSON.stringify({
          data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60, can_post_more: true },
          error: { code: "ok" }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { publish_id: "publish-duration-ok" }, error: { code: "ok" } }), { status: 200 });
    }
  });
  const result = await client.publish({
    content,
    account,
    mediaAssets: [timedAsset],
    tiktokApproval: approval,
    idempotencyKey: "idem-duration-ok"
  });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-duration-ok" });
});


test("TikTok provider HTTP errors retain status and code for safe route mapping", async () => {
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: "access_token_invalid",
        message: "The access token is invalid or not found in the request."
      }
    }), { status: 401 })
  });

  await assert.rejects(client.getCreatorInfo(account), (error: unknown) => {
    assert.ok(error instanceof TikTokProviderRequestError);
    assert.equal(error.upstreamStatus, 401);
    assert.equal(error.providerCode, "access_token_invalid");
    assert.match(error.message, /access token is invalid/);
    return true;
  });
});


test("TikTok FILE_UPLOAD keeps the final chunk within the declared video size when chunk size rounds up", async () => {
  const videoSize = 65 * 1024 * 1024 + 1;
  const expectedChunkSize = Math.ceil(videoSize / 2);
  const uploadedChunks: Array<{ contentRange: string | null; byteLength: number }> = [];
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async (_url, init, maxBytes) => {
      assert.equal(init.method, "GET");
      assert.equal(maxBytes, videoSize);
      return new Response(createByteStream(videoSize), { status: 200, headers: { "content-length": String(videoSize) } });
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      if (url.includes("/video/init/")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.source_info.video_size, videoSize);
        assert.equal(body.source_info.chunk_size, expectedChunkSize);
        assert.equal(body.source_info.total_chunk_count, 2);
        return new Response(JSON.stringify({ data: { publish_id: "publish-chunk-boundary", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      const body = init?.body as Uint8Array;
      uploadedChunks.push({ contentRange: headers.get("content-range"), byteLength: body.byteLength });
      return new Response(null, { status: 201 });
    }
  });
  const result = await client.publish({ content, account, mediaAssets: [{ ...asset, byteSize: videoSize }], tiktokApproval: approval, idempotencyKey: "idem-chunk-boundary" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "publish-chunk-boundary" });
  assert.deepEqual(uploadedChunks, [
    { contentRange: `bytes 0-${expectedChunkSize - 1}/${videoSize}`, byteLength: expectedChunkSize },
    { contentRange: `bytes ${expectedChunkSize}-${videoSize - 1}/${videoSize}`, byteLength: videoSize - expectedChunkSize }
  ]);
});

test("TikTok FILE_UPLOAD rejects source bytes beyond the declared size without uploading the excess", async () => {
  const videoSize = asset.byteSize;
  const uploadedChunks: Array<{ contentRange: string | null; byteLength: number }> = [];
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async () => new Response(createByteStream(videoSize + 1), { status: 200, headers: { "content-length": String(videoSize) } }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      if (url.includes("/video/init/")) return new Response(JSON.stringify({ data: { publish_id: "publish-overrun", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      const headers = new Headers(init?.headers);
      const body = init?.body as Uint8Array;
      uploadedChunks.push({ contentRange: headers.get("content-range"), byteLength: body.byteLength });
      return new Response(null, { status: 201 });
    }
  });
  await assert.rejects(() => client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-overrun" }), /media source size changed during download/);
  assert.deepEqual(uploadedChunks, []);
});

test("TikTok FILE_UPLOAD withholds the final chunk until a large source size is verified", async () => {
  const videoSize = 65 * 1024 * 1024 + 1;
  const expectedChunkSize = Math.ceil(videoSize / 2);
  const uploadedChunks: Array<{ contentRange: string | null; byteLength: number }> = [];
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async () => new Response(createByteStream(videoSize + 1), { status: 200, headers: { "content-length": String(videoSize) } }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      if (url.includes("/video/init/")) return new Response(JSON.stringify({ data: { publish_id: "publish-large-overrun", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      const headers = new Headers(init?.headers);
      const body = init?.body as Uint8Array;
      uploadedChunks.push({ contentRange: headers.get("content-range"), byteLength: body.byteLength });
      return new Response(null, { status: 201 });
    }
  });
  await assert.rejects(() => client.publish({ content, account, mediaAssets: [{ ...asset, byteSize: videoSize }], tiktokApproval: approval, idempotencyKey: "idem-large-overrun" }), /media source size changed during download/);
  assert.deepEqual(uploadedChunks, [
    { contentRange: `bytes 0-${expectedChunkSize - 1}/${videoSize}`, byteLength: expectedChunkSize }
  ]);
});

test("TikTok FILE_UPLOAD rejects an incomplete final chunk before uploading it", async () => {
  const uploadedChunks: Array<{ contentRange: string | null; byteLength: number }> = [];
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async () => new Response(createByteStream(asset.byteSize - 1), { status: 200, headers: { "content-length": String(asset.byteSize) } }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      if (url.includes("/video/init/")) return new Response(JSON.stringify({ data: { publish_id: "publish-underrun", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      const headers = new Headers(init?.headers);
      const body = init?.body as Uint8Array;
      uploadedChunks.push({ contentRange: headers.get("content-range"), byteLength: body.byteLength });
      return new Response(null, { status: 201 });
    }
  });
  await assert.rejects(() => client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-underrun" }), /media source size changed during download/);
  assert.deepEqual(uploadedChunks, []);
});

test("TikTok FILE_UPLOAD rejects a mismatched GET Content-Length before uploading any chunk", async () => {
  const videoSize = asset.byteSize;
  let uploadedChunks = 0;
  const client = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    mediaFetchImpl: async () => new Response(Buffer.alloc(videoSize), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(videoSize - 1) } }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("creator_info")) return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      if (url.includes("/video/init/")) return new Response(JSON.stringify({ data: { publish_id: "publish-length-mismatch", upload_url: "https://upload.example.test/video" } }), { status: 200 });
      if (init?.method === "PUT") uploadedChunks += 1;
      return new Response(null, { status: 201 });
    }
  });
  await assert.rejects(() => client.publish({ content, account, mediaAssets: [asset], tiktokApproval: approval, idempotencyKey: "idem-content-length-mismatch" }), /size changed during download/);
  assert.equal(uploadedChunks, 0);
});

test("TikTok media URL validation rejects local and credential-bearing hosts before publication", async () => {
  for (const mediaTransferMode of ["FILE_UPLOAD", "PULL_FROM_URL"] as const) {
    const calls: string[] = [];
    const client = new TikTokContentPostingClient({
      mediaTransferMode,
      accessTokenResolver: async () => "secret-token",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
      }
    });
    await assert.rejects(() => client.publish({
      content, account, mediaAssets: [{ ...asset, reference: "https://127.0.0.1/video.mp4" }],
      tiktokApproval: approval, idempotencyKey: "idem-private-url-" + mediaTransferMode
    }), /credential-free HTTPS .*public-looking hostname/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /creator_info/);
  }
  const photoCalls: string[] = [];
  const photoClient = new TikTokContentPostingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input) => {
      photoCalls.push(String(input));
      return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"] } }), { status: 200 });
    }
  });
  await assert.rejects(() => photoClient.publish({
    content, account,
    mediaAssets: [{ ...asset, kind: "image", reference: "https://user:secret@media.example.com/product.jpg" }],
    tiktokApproval: approval, idempotencyKey: "idem-private-photo-url"
  }), /credential-free HTTPS URL with a public-looking hostname/i);
  assert.equal(photoCalls.length, 1);
  assert.match(photoCalls[0] ?? "", /creator_info/);
});
