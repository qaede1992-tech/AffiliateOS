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

test("a successful Openverse request clears an active provider pause", () => {
  resetOpenverseCircuitForTests();
  recordOpenverseFailure({
    endpoint: "token",
    status: 403,
    contentType: "application/json",
    server: null,
    cloudflareRayPresent: false,
    cloudflareRayId: null,
    responseKind: "json_error"
  });
  assert.throws(() => assertOpenverseAvailable());
  recordOpenverseSuccess();
  assert.doesNotThrow(() => assertOpenverseAvailable());
});
