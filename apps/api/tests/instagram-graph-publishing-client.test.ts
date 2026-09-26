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

test("Instagram client creates and publishes a media container", async () => {
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
      assert.match(body, /creation_id=container-1/);
      return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
    }
  });
  const result = await client.publish({ content, account, mediaAssets: [asset], idempotencyKey: "idem-1" });
  assert.deepEqual(result, { status: "published", providerOperationId: "media-1" });
  assert.equal(calls.length, 2);
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
