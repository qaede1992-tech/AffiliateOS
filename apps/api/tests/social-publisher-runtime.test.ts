import assert from "node:assert/strict";
import test from "node:test";
import { createOfficialSocialPublishers } from "../src/domain/social-publisher-runtime.js";
import { InMemorySocialCredentialResolver, JsonSocialCredentialResolver } from "../src/domain/social-credentials.js";

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
