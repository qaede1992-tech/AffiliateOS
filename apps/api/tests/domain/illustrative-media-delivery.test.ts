import assert from "node:assert/strict";
import test from "node:test";
import { IllustrativeMediaDeliveryService, type IllustrativeCreativeRecord } from "../../src/domain/illustrative-media-delivery.js";
import { IllustrativeMediaTokenSigner } from "../../src/domain/illustrative-media-token.js";

const creativeId = "11111111-1111-4111-8111-111111111111";
const mediaAssetId = "22222222-2222-4222-8222-222222222222";
const contentId = "33333333-3333-4333-8333-333333333333";
const digest = "a".repeat(64);
const secret = "test-only-illustrative-media-secret-32-bytes-min";
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

const validCreative = (): IllustrativeCreativeRecord => ({
  id: creativeId, mediaAssetId, contentId, platform: "instagram", sha256: digest,
  mimeType: "video/mp4", byteSize: bytes.byteLength, disclosureEmbedded: true,
  reviewStatus: "approved", storageBackend: "local_volume", storageKey: `${creativeId}-${digest}.mp4`
});

function setup(overrides: {
  creative?: Partial<IllustrativeCreativeRecord>;
  policyEnabled?: boolean;
  dispatchState?: string;
} = {}) {
  let currentCreative: IllustrativeCreativeRecord | undefined = { ...validCreative(), ...overrides.creative };
  let policyEnabled = overrides.policyEnabled ?? true;
  let dispatchState = overrides.dispatchState ?? "dispatching";
  let fileReads = 0;
  const signer = new IllustrativeMediaTokenSigner(secret);
  const service = new IllustrativeMediaDeliveryService({
    creatives: { findById: async () => currentCreative },
    policies: { isEnabled: async () => policyEnabled },
    dispatches: { findActiveByContentProvider: async (id, provider) =>
      dispatchState ? { contentId: id, provider, state: dispatchState } : undefined },
    files: { get: async () => { fileReads++; return bytes; } },
    signer
  });
  return {
    service, signer,
    setCreative(value: IllustrativeCreativeRecord | undefined) { currentCreative = value; },
    setPolicy(value: boolean) { policyEnabled = value; },
    setDispatch(value: string) { dispatchState = value; },
    get fileReads() { return fileReads; }
  };
}

test("issues a lifecycle-revoked token only for approved Instagram creative and active dispatch", async () => {
  const state = setup();
  const token = await state.service.issueToken(creativeId);
  const claims = state.signer.verify(token, { creativeId, mediaAssetId, contentId, sha256: digest });
  assert.equal(claims.expiresAtSeconds, null);
});

test("does not issue a token when policy, review, storage, or dispatch gates fail", async () => {
  await assert.rejects(setup({ policyEnabled: false }).service.issueToken(creativeId));
  await assert.rejects(setup({ creative: { reviewStatus: "pending" } }).service.issueToken(creativeId));
  await assert.rejects(setup({ creative: { storageBackend: null, storageKey: null } }).service.issueToken(creativeId));
  await assert.rejects(setup({ dispatchState: "published" }).service.issueToken(creativeId));
  await assert.rejects(setup({ dispatchState: "reserved" }).service.issueToken(creativeId));
});

test("serves full and partial content while the matching dispatch remains active", async () => {
  const state = setup();
  const token = await state.service.issueToken(creativeId);
  const full = await state.service.read({ creativeId, token });
  assert.equal(full.status, 200);
  assert.equal(full.byteSize, 10);
  assert.deepEqual(full.bytes, bytes);
  const partial = await state.service.read({ creativeId, token, range: "bytes=2-5" });
  assert.equal(partial.status, 206);
  assert.equal(partial.byteSize, 4);
  assert.equal(partial.contentRange, "bytes 2-5/10");
  assert.deepEqual(partial.bytes, new Uint8Array([2, 3, 4, 5]));
});

test("revokes an issued token as soon as the durable dispatch becomes terminal", async () => {
  const state = setup();
  const token = await state.service.issueToken(creativeId);
  state.setDispatch("published");
  await assert.rejects(state.service.read({ creativeId, token }));
  state.setDispatch("failed");
  await assert.rejects(state.service.read({ creativeId, token }));
});

test("HEAD does not read file bytes and unsatisfiable ranges return 416 metadata", async () => {
  const state = setup();
  const token = await state.service.issueToken(creativeId);
  const head = await state.service.read({ creativeId, token, head: true });
  assert.equal(head.status, 200);
  assert.equal(head.bytes, undefined);
  assert.equal(state.fileReads, 0);
  const missing = await state.service.read({ creativeId, token, range: "bytes=99-" });
  assert.equal(missing.status, 416);
  assert.equal(missing.contentRange, "bytes */10");
  assert.equal(state.fileReads, 0);
});

test("does not serve a token for a different creative or changed media metadata", async () => {
  const state = setup();
  const token = await state.service.issueToken(creativeId);
  await assert.rejects(state.service.read({ creativeId: "44444444-4444-4444-8444-444444444444", token }));
  state.setCreative({ ...validCreative(), sha256: "b".repeat(64) });
  await assert.rejects(state.service.read({ creativeId, token }));
});
