import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfficialSocialPublishers } from "../src/domain/social-publisher-runtime.js";
import { InMemorySocialCredentialResolver, JsonSocialCredentialResolver } from "../src/domain/social-credentials.js";
import { EncryptedFileSocialCredentialStore } from "../src/domain/encrypted-file-social-credentials.js";

test("official social publishers stay disabled without a credential resolver", () => {
  assert.deepEqual(createOfficialSocialPublishers({}), []);
});

test("official social publishers are composed when a credential resolver is configured", () => {
  const resolver = new InMemorySocialCredentialResolver();
  const publishers = createOfficialSocialPublishers({ credentialResolver: resolver });
  assert.equal(publishers.length, 2);
  assert.equal(publishers.filter((publisher) => publisher.supports("tiktok")).length, 1);
  assert.equal(publishers.filter((publisher) => publisher.supports("instagram")).length, 1);
});

test("runtime credential values may be opaque access-token records without exposing references", async () => {
  const resolver = new InMemorySocialCredentialResolver();
  resolver.set("vault://social/tiktok/account-1", { accessToken: "runtime-only-token" });
  const publishers = createOfficialSocialPublishers({ credentialResolver: resolver });
  const tiktok = publishers.find((publisher) => publisher.supports("tiktok"));
  assert.ok(tiktok);
  assert.equal(tiktok.provider, "tiktok-content-posting");
  assert.doesNotMatch(JSON.stringify(tiktok), /runtime-only-token/);
});

test("JSON social credential resolver resolves opaque references without exposing unrelated entries", async () => {
  const resolver = JsonSocialCredentialResolver.fromJson(JSON.stringify({
    "secret://affiliateos/social/tiktok/account-1": { accessToken: "runtime-token" },
    "secret://affiliateos/social/instagram/account-2": { accessToken: "other-token" }
  }));
  assert.deepEqual(
    await resolver.resolve("secret://affiliateos/social/tiktok/account-1"),
    { accessToken: "runtime-token" }
  );
  await assert.rejects(
    () => resolver.resolve("secret://affiliateos/social/missing"),
    /not found/i
  );
});

test("JSON social credential resolver rejects malformed deployment configuration", () => {
  assert.throws(() => JsonSocialCredentialResolver.fromJson("not-json"), /valid JSON/i);
  assert.throws(() => JsonSocialCredentialResolver.fromJson("[]"), /JSON object/i);
});

test("encrypted file credential store persists and resolves credentials without plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "affiliateos-social-credentials-"));
  const filePath = join(directory, "social-credentials.enc");
  try {
    const store = EncryptedFileSocialCredentialStore.fromSecret(filePath, "a".repeat(32));
    await store.store("secret://affiliateos/social/instagram/account-1", { accessToken: "runtime-secret-token" });
    assert.deepEqual(
      await store.resolve("secret://affiliateos/social/instagram/account-1"),
      { accessToken: "runtime-secret-token" }
    );
    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /runtime-secret-token/);
    assert.doesNotMatch(persisted, /secret:\/\/affiliateos\/social\/instagram\/account-1/);
    await store.delete("secret://affiliateos/social/instagram/account-1");
    await assert.rejects(
      () => store.resolve("secret://affiliateos/social/instagram/account-1"),
      /not found/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("encrypted file credential store rejects a short secret", () => {
  assert.throws(
    () => EncryptedFileSocialCredentialStore.fromSecret("/tmp/social.enc", "short"),
    /at least 32 characters/i
  );
});

test("encrypted file credential store refuses tampered ciphertext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "affiliateos-social-credentials-tamper-"));
  const filePath = join(directory, "social-credentials.enc");
  try {
    const store = EncryptedFileSocialCredentialStore.fromSecret(filePath, "b".repeat(32));
    await store.store("secret://affiliateos/social/tiktok/account-1", { accessToken: "tamper-secret" });
    const envelope = JSON.parse(await readFile(filePath, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] ^= 0xff;
    envelope.ciphertext = ciphertext.toString("base64");
    await writeFile(filePath, JSON.stringify(envelope), "utf8");
    await assert.rejects(
      () => store.resolve("secret://affiliateos/social/tiktok/account-1"),
      /unable to read social credential store/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { InstagramGraphPublishingClient } from "../src/domain/instagram-graph-publishing-client.js";
import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "../src/domain/media-asset.js";
import type { PublicationOperation } from "../src/domain/publication-operation.js";

const instagramAccount = { id: "account-1", provider: "instagram", platform: "instagram", accountReference: "ig-user-1" } as SocialAccount;
const instagramContent = { id: "content-1", platform: "instagram", title: "Test caption", caption: "Test caption" } as Content;
const storageAsset = { id: "asset-1", contentId: "content-1", kind: "image", source: "object-storage", reference: "affiliate-media/content-1/photo.jpg", mimeType: "image/jpeg" } as MediaAsset;
const instagramOperation = { id: "operation-1", contentId: "content-1", jobId: "job-1", provider: "instagram-graph", providerOperationId: "container-1", status: "processing", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as PublicationOperation;
const instagramJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

test("Instagram resolves Supabase object-storage media to signed HTTPS and records media_publish ID", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "test-token",
    mediaUrlResolver: async () => "https://storage.example/signed/photo.jpg?token=temporary",
    graphBaseUrl: "https://graph.instagram.com/v25.0",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), init });
      if (url.pathname.endsWith("/media") && !url.pathname.endsWith("/media_publish")) return instagramJson({ id: "container-123" });
      if (url.pathname.endsWith("/container-123")) return instagramJson({ id: "container-123", status_code: "FINISHED" });
      if (url.pathname.endsWith("/media_publish")) return instagramJson({ id: "published-media-123" });
      throw new Error("Unexpected Instagram request");
    }
  });
  const result = await client.publish({ content: instagramContent, account: instagramAccount, mediaAssets: [storageAsset], idempotencyKey: "test-idempotency" });
  assert.deepEqual(result, { status: "accepted", providerOperationId: "container-123" });
  assert.equal(calls.length, 1);
  assert.equal(((calls[0].init?.body) as URLSearchParams).get("image_url"), "https://storage.example/signed/photo.jpg?token=temporary");
  const published = await client.checkPublication({ content: instagramContent, account: instagramAccount, mediaAssets: [storageAsset], operation: instagramOperation });
  assert.deepEqual(published, { status: "published", externalPostId: "published-media-123" });
  assert.equal(calls.length, 3);
  assert.equal(((calls[2].init?.body) as URLSearchParams).get("creation_id"), "container-123");
});

test("Instagram never reports a PUBLISHED container ID as the actual post ID", async () => {
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "test-token",
    graphBaseUrl: "https://graph.instagram.com/v25.0",
    fetchImpl: async () => instagramJson({ id: "container-123", status_code: "PUBLISHED" })
  });
  const result = await client.checkPublication({ content: instagramContent, account: instagramAccount, mediaAssets: [storageAsset], operation: instagramOperation });
  assert.deepEqual(result, { status: "processing" });
});

test("Instagram rejects non-HTTPS resolved media before calling Graph API", async () => {
  const client = new InstagramGraphPublishingClient({
    accessTokenResolver: async () => "test-token",
    mediaUrlResolver: async () => "http://storage.example/photo.jpg",
    fetchImpl: async () => { throw new Error("Graph API should not be called"); }
  });
  await assert.rejects(() => client.publish({ content: instagramContent, account: instagramAccount, mediaAssets: [storageAsset], idempotencyKey: "test-idempotency" }), /publicly accessible HTTPS/i);
});
