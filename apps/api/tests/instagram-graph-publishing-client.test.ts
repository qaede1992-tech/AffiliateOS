import assert from "node:assert/strict";
import test from "node:test";
import { InstagramGraphPublishingClient } from "../src/domain/instagram-graph-publishing-client.js";

const account = {
  id: "ig-account",
  platform: "instagram",
  accountReference: "178900000001",
  status: "active" as const,
  connection: {},
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};
const content = {
  id: "content-1",
  platform: "instagram" as const,
  contentType: "affiliate-promotion",
  caption: "Affiliate test",
  status: "scheduled" as const,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};
const asset = {
  id: "asset-1",
  contentId: "content-1",
  kind: "image" as const,
  source: "url" as const,
  reference: "https://media.example.test/image.jpg",
  mimeType: "image/jpeg",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};

test("Instagram image publishing persists its container before media_publish", async () => {
  const calls: string[] = [];
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      const body = String(init?.body ?? "");
      if (String(input).endsWith("/media")) {
        assert.match(body, /image_url/);
        return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      }
      if (String(input).includes("/container-1?")) {
        return new Response(JSON.stringify({ id: "container-1", status_code: "FINISHED" }), { status: 200 });
      }
      assert.match(body, /creation_id=container-1/);
      return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
    }
  });
  const result = await client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-1" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "container-1" });
  assert.equal(calls.length, 1);

  const published = await client.checkPublication({
    content, account, mediaAssets: [asset],
    operation: {
      id: "operation-image", jobId: "job-1", contentId: "content-1",
      provider: "instagram-graph-publishing", providerOperationId: "container-1",
      status: "accepted", attemptCount: 1,
      createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z"
    }
  });
  assert.deepEqual(published, { status: "published", externalPostId: "media-1" });
  assert.equal(calls.length, 3);
});

test("Instagram client rejects non-HTTPS media", async () => {
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async () => new Response("{}", { status: 200 })
  });
  await assert.rejects(() => client.publish({
    content,
    account,
    mediaAssets: [{ ...asset, reference: "http://media.example.test/image.jpg" }],
    idempotencyKey: "idem-1"
  }), /HTTPS/);
});


test("Instagram video publishing waits for a finished container before media_publish", async () => {
  const videoAsset = { ...asset, kind: "video" as const, mimeType: "video/mp4", reference: "https://media.example.test/reel.mp4" };
  const calls: string[] = [];
  let status = "IN_PROGRESS";
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith("/media")) return new Response(JSON.stringify({ id: "container-2" }), { status: 200 });
      if (url.pathname.endsWith("/container-2")) return new Response(JSON.stringify({ id: "container-2", status_code: status }), { status: 200 });
      if (url.pathname.endsWith("/media_publish")) {
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body ?? ""), /creation_id=container-2/);
      }
      return new Response(JSON.stringify({ id: "media-2" }), { status: 200 });
    }
  });

  const accepted = await client.publish({ content, account, mediaAssets: [videoAsset], idempotencyKey: "idem-video" });
  assert.deepEqual(accepted, { status: "accepted", providerOperationId: "container-2" });
  assert.equal(calls.length, 1);

  const processing = await client.checkPublication({
    content,
    account,
    mediaAssets: [videoAsset],
    operation: { ...({
      id: "operation-video",
      jobId: "job-1",
      contentId: "content-1",
      provider: "instagram-graph-publishing",
      providerOperationId: "container-2",
      status: "accepted" as const,
      attemptCount: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z"
    }) }
  });
  assert.deepEqual(processing, { status: "processing" });

  status = "FINISHED";
  const published = await client.checkPublication({
    content,
    account,
    mediaAssets: [videoAsset],
    operation: { ...({
      id: "operation-video",
      jobId: "job-1",
      contentId: "content-1",
      provider: "instagram-graph-publishing",
      providerOperationId: "container-2",
      status: "accepted" as const,
      attemptCount: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z"
    }) }
  });
  assert.deepEqual(published, { status: "published", externalPostId: "media-2" });
  assert.equal(calls.length, 4);
});

test("Instagram recovers the actual media ID only for a unique recent caption match", async () => {
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/container-published")) {
        return new Response(JSON.stringify({ id: "container-published", status_code: "PUBLISHED" }), { status: 200 });
      }
      if (url.pathname.endsWith("/178900000001/media")) {
        assert.match(url.searchParams.get("fields") ?? "", /caption/);
        return new Response(JSON.stringify({ data: [{ id: "actual-media-7", caption: "Affiliate test", timestamp: "2026-09-26T00:02:00+0000", media_type: "IMAGE" }] }), { status: 200 });
      }
      throw new Error("Unexpected Instagram request");
    }
  });
  const result = await client.checkPublication({
    content, account, mediaAssets: [asset],
    operation: { id: "op-published", jobId: "job-1", contentId: "content-1", provider: "instagram-graph-publishing", providerOperationId: "container-published", status: "processing", attemptCount: 1, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" }
  });
  assert.deepEqual(result, { status: "published", externalPostId: "actual-media-7" });
});

test("Instagram keeps published status pending when recent media matches are ambiguous", async () => {
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "secret-token",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/container-published")) return new Response(JSON.stringify({ id: "container-published", status_code: "PUBLISHED" }), { status: 200 });
      return new Response(JSON.stringify({ data: [
        { id: "media-a", caption: "Affiliate test", timestamp: "2026-09-26T00:02:00+0000", media_type: "IMAGE" },
        { id: "media-b", caption: "Affiliate test", timestamp: "2026-09-26T00:03:00+0000", media_type: "IMAGE" }
      ] }), { status: 200 });
    }
  });
  const result = await client.checkPublication({
    content, account, mediaAssets: [asset],
    operation: { id: "op-ambiguous", jobId: "job-1", contentId: "content-1", provider: "instagram-graph-publishing", providerOperationId: "container-published", status: "processing", attemptCount: 1, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" }
  });
  assert.deepEqual(result, { status: "processing" });
});