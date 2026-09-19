import assert from "node:assert/strict";
import test from "node:test";
import { createApp, configuredCorsOrigin } from "../../src/app.js";

test("configured CORS origin rejects an unset production origin", () => {
  const previous = process.env.API_CORS_ORIGIN;
  delete process.env.API_CORS_ORIGIN;

  try {
    assert.throws(() => configuredCorsOrigin(true), /API_CORS_ORIGIN must be configured in production/);
  } finally {
    if (previous === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = previous;
  }
});

test("configured CORS origin keeps the development fallback outside production", () => {
  const previous = process.env.API_CORS_ORIGIN;
  delete process.env.API_CORS_ORIGIN;

  try {
    assert.equal(configuredCorsOrigin(false), "http://localhost:5173");
  } finally {
    if (previous === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = previous;
  }
});

test("configured CORS origin accepts an explicit production origin", () => {
  const previous = process.env.API_CORS_ORIGIN;
  process.env.API_CORS_ORIGIN = "https://app.example.com";

  try {
    assert.equal(configuredCorsOrigin(true), "https://app.example.com");
  } finally {
    if (previous === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = previous;
  }
});

test("GET /api/v1/health returns health status and configured CORS origin", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { origin: "http://localhost:5173" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(response.json().status, "ok");

  await app.close();
});

test("GET /api/v1/health keeps the configured CORS origin for an untrusted request origin", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { origin: "https://untrusted.example" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.notEqual(response.headers["access-control-allow-origin"], "https://untrusted.example");
  assert.equal(response.json().status, "ok");

  await app.close();
});

test("HTTP runtime rejects request bodies above the configured limit", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "x".repeat(1_050_000),
      email: "partner@example.com",
    },
  });

  assert.equal(response.statusCode, 413);

  await app.close();
});

test("POST /api/v1/affiliates creates an affiliate", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Test Partner",
      email: "partner@example.com",
    },
  });

  assert.equal(response.statusCode, 201);

  const body = response.json();

  assert.equal(body.name, "Test Partner");
  assert.equal(body.email, "partner@example.com");
  assert.ok(body.id);

  await app.close();
});

test("POST /api/v1/offers creates an offer", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Test Offer",
      status: "active",
      commissionRateBps: 1000,
    },
  });

  assert.equal(response.statusCode, 201);

  const body = response.json();

  assert.equal(body.name, "Test Offer");
  assert.equal(body.status, "active");
  assert.equal(body.commissionRateBps, 1000);
  assert.ok(body.id);

  await app.close();
});

test("POST /api/v1/conversions creates a conversion", async () => {
  const app = createApp();

  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Conversion Partner",
      email: "conversion@example.com",
    },
  });

  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Conversion Offer",
      status: "active",
      commissionRateBps: 1250,
    },
  });

  assert.equal(offerResponse.statusCode, 201);
  const offer = offerResponse.json();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: affiliate.id,
      offerId: offer.id,
      amountCents: 10000,
      occurredAt: "2026-01-02T00:00:00.000Z",
    },
  });

  assert.equal(response.statusCode, 201);

  const body = response.json();

  assert.equal(body.affiliateId, affiliate.id);
  assert.equal(body.offerId, offer.id);
  assert.equal(body.amountCents, 10000);
  assert.equal(body.status, "pending");
  assert.ok(body.id);

  await app.close();
});

test("POST /api/v1/conversions creates a pending commission", async () => {
  const app = createApp();

  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Commission Partner",
      email: "commission@example.com",
    },
  });

  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Commission Offer",
      status: "active",
      commissionRateBps: 1250,
    },
  });

  assert.equal(offerResponse.statusCode, 201);
  const offer = offerResponse.json();

  const conversionResponse = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: affiliate.id,
      offerId: offer.id,
      amountCents: 10000,
    },
  });

  assert.equal(conversionResponse.statusCode, 201);
  const conversion = conversionResponse.json();

  const commissionsResponse = await app.inject({
    method: "GET",
    url: "/api/v1/commissions",
  });

  assert.equal(commissionsResponse.statusCode, 200);

  const commissionsBody = commissionsResponse.json();

  assert.ok(Array.isArray(commissionsBody.data));

  const commission = commissionsBody.data.find(
    (item: {
      conversionId: string;
    }) => item.conversionId === conversion.id,
  );

  assert.ok(commission);
  assert.equal(commission.affiliateId, affiliate.id);
  assert.equal(commission.amountCents, 1250);
  assert.equal(commission.status, "pending");

  await app.close();
});

test("POST /api/v1/conversions rejects a missing affiliate", async () => {
  const app = createApp();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Test Offer Missing Affiliate",
      status: "active",
      commissionRateBps: 1250,
    },
  });

  assert.equal(offerResponse.statusCode, 201);

  const offer = offerResponse.json();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: "11111111-1111-4111-8111-111111111111",
      offerId: offer.id,
      amountCents: 10000,
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "AFFILIATE_NOT_FOUND",
    message: "The affiliate does not exist.",
  });

  await app.close();
});

test("POST /api/v1/conversions rejects an inactive offer", async () => {
  const app = createApp();

  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Inactive Offer Affiliate",
      email: "inactive-offer@example.com",
    },
  });

  assert.equal(affiliateResponse.statusCode, 201);

  const affiliate = affiliateResponse.json();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Inactive Test Offer",
      status: "inactive",
      commissionRateBps: 1250,
    },
  });

  assert.equal(offerResponse.statusCode, 201);

  const offer = offerResponse.json();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: affiliate.id,
      offerId: offer.id,
      amountCents: 10000,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "OFFER_NOT_ACTIVE",
    message: "Conversions require an active offer.",
  });

  await app.close();
});

test("POST /api/v1/conversions rejects an amount beyond the database integer range", async () => {
  const app = createApp();

  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Bounded Amount Affiliate",
      email: "bounded-amount@example.com",
    },
  });

  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Bounded Amount Offer",
      status: "active",
      commissionRateBps: 1250,
    },
  });

  assert.equal(offerResponse.statusCode, 201);
  const offer = offerResponse.json();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: affiliate.id,
      offerId: offer.id,
      amountCents: 2147483648,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "VALIDATION_ERROR",
    message: "The request body is invalid.",
  });

  await app.close();
});

test("POST /api/v1/affiliates rejects an invalid payload", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "",
      email: "not-an-email",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "VALIDATION_ERROR",
    message: "The request body is invalid.",
  });

  await app.close();
});

test("OAuth callback is reachable without a bearer token so external providers can complete the redirect", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/social-accounts/oauth/callback?platform=instagram&code=test&state=00000000-0000-4000-8000-000000000000",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_SOCIAL_OAUTH_STATE");

  await app.close();
});
