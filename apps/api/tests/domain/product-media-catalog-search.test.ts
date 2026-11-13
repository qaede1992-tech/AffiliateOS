import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductMediaSearchQuery,
  evaluateProductMediaIdentity,
  searchOpenverseProductMedia
} from "../../src/domain/product-media-catalog-search.js";

const identity = {
  name: "Wireless Headphones WH-1000XM5",
  brand: "Sony",
  model: "WH-1000XM5",
  variant: "Black"
};

test("builds a bounded query from product identity rather than marketplace URLs", () => {
  assert.equal(buildProductMediaSearchQuery(identity), "Sony Wireless Headphones WH-1000XM5 WH-1000XM5 Black");
  assert.ok(buildProductMediaSearchQuery({ name: "x".repeat(300) }).length <= 200);
});

test("requires exact model/SKU evidence for a strong match", () => {
  const match = evaluateProductMediaIdentity(identity, "Sony WH-1000XM5 Wireless Headphones Black");
  assert.equal(match.status, "strong_match");
  assert.ok(match.score >= 90);
});


test("requires variant evidence before returning a strong model match", () => {
  const result = evaluateProductMediaIdentity(identity, "Sony WH-1000XM5 Wireless Headphones");
  assert.equal(result.status, "review_required");
  assert.ok(result.reasons.some((reason) => reason.includes("varian")));
});

test("keeps name-only matches for human review when structured brand and model are unavailable", () => {
  const result = evaluateProductMediaIdentity(
    { name: "Wireless Headphones WH-1000XM5" },
    "Wireless Headphones WH-1000XM5 Black"
  );
  assert.equal(result.status, "review_required");
  assert.ok(result.score >= 65);
});

test("rejects a different model even when brand and product category are similar", () => {
  const mismatch = evaluateProductMediaIdentity(identity, "Sony WH-1000XM4 Wireless Headphones Black");
  assert.equal(mismatch.status, "rejected");
  assert.equal(mismatch.score, 0);
});

test("keeps title-only similarity at human review, never automatic approval", () => {
  const result = evaluateProductMediaIdentity(
    { name: "Wireless Headphones", brand: "Sony" },
    "Sony Wireless Headphones"
  );
  assert.equal(result.status, "review_required");
});

test("rejects IP literals, local names, and reserved hostnames in catalog media URLs", async () => {
  const invalidUrls = [
    "https://127.0.0.1/image.jpg",
    "https://[::1]/image.jpg",
    "https://localhost/image.jpg",
    "https://metadata.google.internal/image.jpg",
    "https://images.example.test/image.jpg"
  ];
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    results: invalidUrls.map((url) => ({
      title: "Sony WH-1000XM5 Wireless Headphones Black",
      url,
      foreign_landing_url: "https://source.example.com/photo",
      license: "cc0"
    }))
  }), { status: 200 });
  assert.deepEqual(await searchOpenverseProductMedia(identity, { fetchImpl }), []);
});

test("searches the official Openverse API and keeps rights unverified", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      results: [
        {
          title: "Sony WH-1000XM5 Wireless Headphones Black",
          url: "https://images.example.com/sony.jpg",
          foreign_landing_url: "https://source.example.com/photo/1",
          creator: "Photographer",
          creator_url: "https://source.example.com/creator",
          license: "by",
          license_version: "4.0",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          source: "example"
        },
        {
          title: "Sony WH-1000XM4 Wireless Headphones",
          url: "https://images.example.com/wrong.jpg",
          foreign_landing_url: "https://source.example.com/photo/2",
          license: "by",
          source: "example"
        },
        {
          title: "Sony WH-1000XM5 Wireless Headphones",
          url: "https://images.example.com/nc.jpg",
          foreign_landing_url: "https://source.example.com/photo/3",
          license: "by-nc",
          source: "example"
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const results = await searchOpenverseProductMedia(identity, { fetchImpl, timeoutMs: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.identityStatus, "strong_match");
  assert.equal(results[0]?.rightsStatus, "unverified");
  assert.match(requested, /^https:\/\/api\.openverse\.org\/v1\/images\//);
  assert.match(requested, /license=cc0%2Cpdm%2Cby%2Cby-sa/);
});


test("uses Openverse client credentials and sends a cached bearer token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/auth_tokens/token/")) {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ results: [{
      title: "Sony WH-1000XM5 Wireless Headphones Black",
      url: "https://images.example.com/sony-auth.jpg",
      foreign_landing_url: "https://source.example.com/photo/auth",
      license: "by",
      source: "example"
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const options = { fetchImpl, clientId: "openverse-test-client", clientSecret: "openverse-test-secret", timeoutMs: 1000 };
  const first = await searchOpenverseProductMedia(identity, options);
  const second = await searchOpenverseProductMedia(identity, options);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  const tokenCalls = calls.filter((call) => call.url.endsWith("/auth_tokens/token/"));
  const searchCalls = calls.filter((call) => call.url.includes("/v1/images/"));
  assert.equal(tokenCalls.length, 1);
  assert.equal(searchCalls.length, 2);
  assert.equal(new Headers(searchCalls[0]?.init?.headers).get("authorization"), "Bearer test-access-token");
  assert.match(String(tokenCalls[0]?.init?.body), /grant_type=client_credentials/);
});

test("coalesces concurrent Openverse token requests for the same client", async () => {
  let tokenCalls = 0;
  let releaseResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { releaseResponse = resolve; });
  const fetchImpl: typeof fetch = async () => {
    tokenCalls += 1;
    return response;
  };
  const options = {
    fetchImpl,
    clientId: "openverse-concurrent-token-client",
    clientSecret: "test-secret",
    timeoutMs: 1000
  };

  const searches = Array.from({ length: 10 }, (_, index) =>
    searchOpenverseProductMedia({ ...identity, name: `Concurrent product ${index}` }, options)
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseResponse(new Response("<html>challenge</html>", {
    status: 403,
    headers: { "content-type": "text/html; charset=UTF-8", server: "cloudflare", "cf-ray": "singleflight-test-ray" }
  }));

  const results = await Promise.allSettled(searches);
  assert.equal(tokenCalls, 1, "concurrent searches must share one in-flight token request");
  assert.equal(results.filter((result) => result.status === "rejected").length, 10);
  assert.ok(results.every((result) => result.status === "rejected" &&
    /token endpoint returned HTTP 403 \(cloudflare_html_challenge\)/.test((result.reason as Error).message)));
});

test("rejects partial Openverse credentials instead of silently falling back to anonymous access", async () => {
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, { clientId: "configured-without-secret" }),
    /must be configured together/
  );
});

test("fails closed for non-official endpoints and invalid result URLs", async () => {
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, { endpoint: "https://attacker.example/api" }),
    /official api.openverse.org/
  );
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    results: [{
      title: "Sony WH-1000XM5 Wireless Headphones",
      url: "http://images.example.test/image.jpg",
      foreign_landing_url: "https://source.example.com/photo",
      license: "cc0"
    }]
  }), { status: 200 });
  assert.deepEqual(await searchOpenverseProductMedia(identity, { fetchImpl }), []);
});


test("classifies token endpoint 401 JSON errors without exposing response bodies", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "invalid_client", error_description: "private diagnostic text" }), {
    status: 401, headers: { "content-type": "application/json" }
  });
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, {
      fetchImpl, clientId: "openverse-401-client", clientSecret: "test-secret", timeoutMs: 1000
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /token endpoint returned HTTP 401 \(json_error\)/);
      assert.equal((error as Error).message.includes("private diagnostic text"), false);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.endpoint, "token");
      assert.equal(details?.status, 401);
      assert.equal(details?.responseKind, "json_error");
      return true;
    }
  );
});

test("classifies token endpoint 403 HTML Cloudflare challenges without reading the body", async () => {
  const fetchImpl: typeof fetch = async () => new Response("<html>challenge secret content</html>", {
    status: 403,
    headers: { "content-type": "text/html; charset=UTF-8", server: "cloudflare", "cf-ray": "test-ray" }
  });
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, {
      fetchImpl, clientId: "openverse-403-html-client", clientSecret: "test-secret", timeoutMs: 1000
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /token endpoint returned HTTP 403 \(cloudflare_html_challenge\)/);
      assert.equal((error as Error).message.includes("challenge secret content"), false);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.endpoint, "token");
      assert.equal(details?.cloudflareRayPresent, true);
      assert.equal(details?.cloudflareRayId, "test-ray");
      assert.equal(details?.responseKind, "cloudflare_html_challenge");
      return true;
    }
  );
});

test("distinguishes image search 403 from token endpoint failures", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/auth_tokens/token/")) {
      return new Response(JSON.stringify({ access_token: "test-search-403-token", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ detail: "forbidden" }), {
      status: 403, headers: { "content-type": "application/json" }
    });
  };
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, {
      fetchImpl, clientId: "openverse-search-403-client", clientSecret: "test-secret", timeoutMs: 1000
    }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.endpoint, "search");
      assert.equal(details?.status, 403);
      assert.equal(details?.responseKind, "json_error");
      return true;
    }
  );
});


test("classifies token endpoint 403 JSON separately from Cloudflare HTML challenges", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "access_denied" }), {
    status: 403, headers: { "content-type": "application/json" }
  });
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, {
      fetchImpl, clientId: "openverse-403-json-client", clientSecret: "test-secret", timeoutMs: 1000
    }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.endpoint, "token");
      assert.equal(details?.status, 403);
      assert.equal(details?.responseKind, "json_error");
      assert.equal(details?.cloudflareRayPresent, false);
      return true;
    }
  );
});
