import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOpenverseAvailable,
  OpenverseCircuitOpenError,
  recordOpenverseFailure,
  recordOpenverseSuccess,
  resetOpenverseCircuitForTests
} from "../../src/domain/openverse-provider-circuit.js";

test("pauses Openverse globally for six hours after HTTP 403", () => {
  resetOpenverseCircuitForTests();
  const now = Date.UTC(2026, 10, 10, 0, 0, 0);
  recordOpenverseFailure({
    endpoint: "search",
    status: 403,
    contentType: "text/html",
    server: "cloudflare",
    cloudflareRayPresent: true,
    cloudflareRayId: "test-ray",
    responseKind: "cloudflare_html_challenge"
  }, now);

  assert.throws(
    () => assertOpenverseAvailable(now + 1),
    (error: unknown) => {
      assert.ok(error instanceof OpenverseCircuitOpenError);
      assert.equal(error.retryAt, new Date(now + 6 * 60 * 60_000).toISOString());
      return true;
    }
  );
  assert.doesNotThrow(() => assertOpenverseAvailable(now + 6 * 60 * 60_000));
  resetOpenverseCircuitForTests();
});

test("does not pause Openverse for non-403 failures", () => {
  resetOpenverseCircuitForTests();
  recordOpenverseFailure({
    endpoint: "search",
    status: 503,
    contentType: "application/json",
    server: null,
    cloudflareRayPresent: false,
    cloudflareRayId: null,
    responseKind: "json_error"
  });
  assert.doesNotThrow(() => assertOpenverseAvailable());
});

test("an in-flight success cannot clear a provider-wide 403 cooldown", () => {
  resetOpenverseCircuitForTests();
  const requestStartedAt = Date.UTC(2026, 10, 10, 0, 0, 0);

  // One search passed the gate before a concurrent search received HTTP 403.
  assert.doesNotThrow(() => assertOpenverseAvailable(requestStartedAt));
  recordOpenverseFailure({
    endpoint: "token",
    status: 403,
    contentType: "application/json",
    server: null,
    cloudflareRayPresent: false,
    cloudflareRayId: null,
    responseKind: "json_error"
  }, requestStartedAt + 1);

  // The earlier search succeeds after the circuit has already opened.
  recordOpenverseSuccess(requestStartedAt + 2);
  assert.throws(
    () => assertOpenverseAvailable(requestStartedAt + 3),
    (error: unknown) => error instanceof OpenverseCircuitOpenError
  );

  // A new request may probe again after the full cooldown expires.
  assert.doesNotThrow(() => assertOpenverseAvailable(requestStartedAt + 6 * 60 * 60_000));
  resetOpenverseCircuitForTests();
});
