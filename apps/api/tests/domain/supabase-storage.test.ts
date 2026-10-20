import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SupabaseStorageClient, createSupabaseStorageClientFromEnv } from "../../src/domain/supabase-storage.js";

const makeClient = (fetchImpl: typeof fetch = async () => new Response(null, { status: 200 })) =>
  new SupabaseStorageClient({
    supabaseUrl: "https://project.supabase.co",
    serviceKey: "server-secret",
    bucket: "affiliate-media",
    fetchImpl
  });

describe("SupabaseStorageClient", () => {
  it("uploads bytes with server-side credentials and returns only the object reference", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = makeClient(async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ Key: "affiliate-media/content-1/photo.jpg" }), { status: 200 });
    });

    const result = await client.upload({
      key: "content-1/photo.jpg",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg"
    });

    assert.deepEqual(result, { bucket: "affiliate-media", key: "content-1/photo.jpg" });
    assert.match(requestUrl, /storage\/v1\/object\/affiliate-media\/content-1\/photo\.jpg$/);
    assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer server-secret");
    assert.equal((requestInit?.headers as Record<string, string>)["x-upsert"], "false");
  });

  it("rejects invalid keys, empty uploads, and unsafe signed URL expiry", async () => {
    const client = makeClient();
    await assert.rejects(client.upload({ key: "../escape.jpg", bytes: new Uint8Array([1]), contentType: "image/jpeg" }), /Invalid Storage object key/);
    await assert.rejects(client.upload({ key: "content/bad\nkey.jpg", bytes: new Uint8Array([1]), contentType: "image/jpeg" }), /Invalid Storage object key/);
    await assert.rejects(client.upload({ key: "image.jpg", bytes: new Uint8Array(), contentType: "image/jpeg" }), /non-empty bytes/);
    await assert.rejects(client.createSignedUrl("image.jpg", 3601), /between 1 and 3600/);
  });

  it("does not expose upstream error bodies", async () => {
    const client = makeClient(async () => new Response("secret upstream details", { status: 403 }));
    await assert.rejects(
      client.upload({ key: "content-1/photo.jpg", bytes: new Uint8Array([1]), contentType: "image/jpeg" }),
      (error: unknown) => error instanceof Error && error.message === "Supabase Storage upload failed (HTTP 403)." && !error.message.includes("secret")
    );
  });

  it("accepts only signed URLs returned for the configured Supabase origin", async () => {
    const valid = makeClient(async () => new Response(JSON.stringify({ signedURL: "/storage/v1/object/sign/affiliate-media/photo.jpg?token=abc" }), { status: 200 }));
    assert.match(await valid.createSignedUrl("photo.jpg", 300), /^https:\/\/project\.supabase\.co\//);

    const invalid = makeClient(async () => new Response(JSON.stringify({ signedURL: "https://attacker.example/steal" }), { status: 200 }));
    await assert.rejects(invalid.createSignedUrl("photo.jpg", 300), /unexpected origin/);
  });

  it("rejects Supabase URLs that contain credentials or non-origin components", () => {
    for (const supabaseUrl of [
      "https://user:password@project.supabase.co",
      "https://project.supabase.co/other-path",
      "https://project.supabase.co?redirect=example",
      "https://project.supabase.co#fragment"
    ]) {
      assert.throws(() => new SupabaseStorageClient({ supabaseUrl, serviceKey: "server-secret", bucket: "affiliate-media" }));
    }
  });

  it("requires all storage environment settings together", () => {
    assert.equal(createSupabaseStorageClientFromEnv({}), undefined);
    assert.throws(() => createSupabaseStorageClientFromEnv({ SUPABASE_URL: "https://project.supabase.co" }), /must be configured together/);
  });
});
