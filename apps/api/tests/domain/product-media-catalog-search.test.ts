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

test("searches the official Openverse API and keeps rights unverified", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      results: [
        {
          title: "Sony WH-1000XM5 Wireless Headphones Black",
          url: "https://images.example.test/sony.jpg",
          foreign_landing_url: "https://source.example.test/photo/1",
          creator: "Photographer",
          creator_url: "https://source.example.test/creator",
          license: "by",
          license_version: "4.0",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          source: "example"
        },
        {
          title: "Sony WH-1000XM4 Wireless Headphones",
          url: "https://images.example.test/wrong.jpg",
          foreign_landing_url: "https://source.example.test/photo/2",
          license: "by",
          source: "example"
        },
        {
          title: "Sony WH-1000XM5 Wireless Headphones",
          url: "https://images.example.test/nc.jpg",
          foreign_landing_url: "https://source.example.test/photo/3",
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

test("fails closed for non-official endpoints and invalid result URLs", async () => {
  await assert.rejects(
    () => searchOpenverseProductMedia(identity, { endpoint: "https://attacker.example/api" }),
    /official api.openverse.org/
  );
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    results: [{
      title: "Sony WH-1000XM5 Wireless Headphones",
      url: "http://images.example.test/image.jpg",
      foreign_landing_url: "https://source.example.test/photo",
      license: "cc0"
    }]
  }), { status: 200 });
  assert.deepEqual(await searchOpenverseProductMedia(identity, { fetchImpl }), []);
});
