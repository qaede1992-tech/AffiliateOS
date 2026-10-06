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
    envelope.ciphertext = "X" + envelope.ciphertext.slice(1);
    await writeFile(filePath, JSON.stringify(envelope), "utf8");
    await assert.rejects(
      () => store.resolve("secret://affiliateos/social/tiktok/account-1"),
      /unable to read social credential store/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
