import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ProviderReplayGuard, verifyProviderEventSignature } from "../../src/http/provider-signature.js";

const secret = "provider-signing-secret";
const rawBody = JSON.stringify({ event: "conversion.created", id: "evt_123" });
const nowMs = Date.parse("2026-09-20T10:00:00.000Z");
const timestamp = Math.floor(nowMs / 1000).toString();
const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

const headers = { timestamp, signature: `v1=${signature}` };

test("accepts a valid provider signature within the replay window", () => {
  assert.equal(verifyProviderEventSignature(rawBody, secret, headers, nowMs), true);
});

test("rejects a tampered body", () => {
  assert.equal(verifyProviderEventSignature(`${rawBody} `, secret, headers, nowMs), false);
});

test("rejects a wrong secret", () => {
  assert.equal(verifyProviderEventSignature(rawBody, "wrong-secret", headers, nowMs), false);
});

test("rejects an expired timestamp", () => {
  const expiredMs = nowMs - 6 * 60 * 1000;
  const expiredTimestamp = Math.floor(expiredMs / 1000).toString();
  const expiredSignature = createHmac("sha256", secret).update(`${expiredTimestamp}.${rawBody}`).digest("hex");

  assert.equal(
    verifyProviderEventSignature(rawBody, secret, { timestamp: expiredTimestamp, signature: `v1=${expiredSignature}` }, nowMs),
    false,
  );
});

test("rejects timestamps too far in the future", () => {
  const futureMs = nowMs + 31 * 1000;
  const futureTimestamp = Math.floor(futureMs / 1000).toString();
  const futureSignature = createHmac("sha256", secret).update(`${futureTimestamp}.${rawBody}`).digest("hex");

  assert.equal(
    verifyProviderEventSignature(rawBody, secret, { timestamp: futureTimestamp, signature: `v1=${futureSignature}` }, nowMs),
    false,
  );
});

test("rejects a signature with a mismatched embedded timestamp", () => {
  assert.equal(verifyProviderEventSignature(rawBody, secret, { timestamp, signature: `t=${Number(timestamp) + 1},v1=${signature}` }, nowMs), false);
});

test("replay guard accepts an event once within its scope", () => {
  const guard = new ProviderReplayGuard(60_000, 10);

  assert.equal(guard.consume("account-a", "evt_123", nowMs), true);
  assert.equal(guard.consume("account-a", "evt_123", nowMs + 1), false);
});

test("replay guard allows the same external event id in different scopes", () => {
  const guard = new ProviderReplayGuard(60_000, 10);

  assert.equal(guard.consume("account-a", "evt_123", nowMs), true);
  assert.equal(guard.consume("account-b", "evt_123", nowMs + 1), true);
});

test("replay guard expires old event ids", () => {
  const guard = new ProviderReplayGuard(60_000, 10);

  assert.equal(guard.consume("account-a", "evt_123", nowMs), true);
  assert.equal(guard.consume("account-a", "evt_123", nowMs + 60_001), true);
});

test("replay guard stays bounded by evicting the oldest event", () => {
  const guard = new ProviderReplayGuard(60_000, 2);

  assert.equal(guard.consume("account-a", "evt_1", nowMs), true);
  assert.equal(guard.consume("account-a", "evt_2", nowMs + 1), true);
  assert.equal(guard.consume("account-a", "evt_3", nowMs + 2), true);
  assert.equal(guard.consume("account-a", "evt_1", nowMs + 3), true);
});
