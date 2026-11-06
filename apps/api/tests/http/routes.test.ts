import assert from "node:assert/strict";
import test from "node:test";
import { createApp, configuredCorsOrigin } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";

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

test("GET /r/:code is public and returns a tracking-link error without authentication", async () => {
  const app = createApp();

  const response = await app.inject({
    method: "GET",
    url: "/r/missing-tracking-code",
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "TRACKING_LINK_NOT_FOUND");

  await app.close();
});

test("GET / is a public liveness endpoint for deployment probes", async () => {
  const app = createApp(undefined, {
    auth: { enabled: true, token: "test-api-token", operatorId: "operator-test", role: "operator" },
  });

  const response = await app.inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: "affiliateos-api" });

  await app.close();
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

test("POST /api/v1/conversions preserves affiliateOfferId for commission selection", async () => {
  const app = createApp();

  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: {
      name: "Affiliate Offer Partner",
      email: "affiliate-offer@example.com",
    },
  });

  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();

  const offerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/offers",
    payload: {
      name: "Affiliate Offer Conversion",
      status: "active",
      commissionRateBps: 0,
    },
  });

  assert.equal(offerResponse.statusCode, 201);
  const offer = offerResponse.json();

  const affiliateOfferId = "11111111-1111-4111-8111-111111111111";
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/conversions",
    payload: {
      affiliateId: affiliate.id,
      offerId: offer.id,
      affiliateOfferId,
      amountCents: 6900000,
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "AFFILIATE_OFFER_NOT_FOUND",
    message: "The affiliate offer does not exist.",
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
    url: "/api/v1/social-accounts/oauth/callback?code=test&state=00000000-0000-4000-8000-000000000000.instagram",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_SOCIAL_OAUTH_STATE");

  await app.close();
});


test("GET /api/v1/autonomous/runs exposes operator recovery state", async () => {
  const { createInMemoryServices } = await import("../../src/domain/container.js");
  const services = createInMemoryServices();
  const app = createApp(services);
  const run = await services.autonomousRuns.accept({ idempotencyKey: "operator-list-accepted", productId: "11111111-1111-4111-8111-111111111111", offerId: "22222222-2222-4222-8222-222222222222" });
  await services.autonomousRuns.transition(run.id, "processing");
  await services.autonomousRuns.transition(run.id, "failed", { error: "temporary failure" });
  const response = await app.inject({ method: "GET", url: "/api/v1/autonomous/runs?status=failed&limit=10" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.length, 1);
  assert.equal(response.json().data[0].id, run.id);
  await app.close();
});

test("GET /api/v1/autonomous/runs/:runId returns 404 for an unknown run", async () => {
  const app = createApp();
  const response = await app.inject({ method: "GET", url: "/api/v1/autonomous/runs/33333333-3333-4333-8333-333333333333" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "AUTONOMOUS_RUN_NOT_FOUND");
  await app.close();
});

test("POST /api/v1/autonomous/runs/:runId/retry resets a failed run for operator recovery", async () => {
  const { createInMemoryServices } = await import("../../src/domain/container.js");
  const services = createInMemoryServices();
  const app = createApp(services);
  const idempotencyKey = "manual-recovery-http-test";
  const accepted = await services.autonomousRuns.accept({
    idempotencyKey,
    productId: "11111111-1111-4111-8111-111111111111",
    offerId: "22222222-2222-4222-8222-222222222222",
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await services.autonomousRuns.transition(accepted.id, "processing");
    await services.autonomousRuns.transition(accepted.id, "failed", { error: "temporary failure" });
  }
  const exhausted = await services.autonomousRuns.findById(accepted.id);
  assert.equal(exhausted?.attemptCount, 8);
  assert.equal(exhausted?.status, "failed");
  const response = await app.inject({ method: "POST", url: `/api/v1/autonomous/runs/${accepted.id}/retry` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.id, accepted.id);
  assert.equal(body.idempotencyKey, idempotencyKey);
  assert.equal(body.status, "failed");
  assert.equal(body.attemptCount, 0);
  assert.equal(body.nextAttemptAt, undefined);
  assert.equal(body.lastError, undefined);
  await app.close();
});

test("POST /api/v1/autonomous/runs/:runId/retry rejects an unknown run", async () => {
  const app = createApp();
  const response = await app.inject({ method: "POST", url: "/api/v1/autonomous/runs/33333333-3333-4333-8333-333333333333/retry" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "AUTONOMOUS_RUN_NOT_FOUND");
  await app.close();
});


test("GET /api/v1/publishers/readiness requires an authorized operator", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();

  const publicApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const publicResponse = await publicApp.inject({
    method: "GET",
    url: "/api/v1/publishers/readiness",
  });
  assert.equal(publicResponse.statusCode, 401);
  await publicApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const operatorResponse = await operatorApp.inject({
    method: "GET",
    url: "/api/v1/publishers/readiness",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(operatorResponse.statusCode, 200);
  assert.ok(Array.isArray(operatorResponse.json().data));
  await operatorApp.close();
});

test("GET /api/v1/autonomous/health requires an authorized operator and exposes run/publisher health", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();

  const unauthorizedApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const unauthorized = await unauthorizedApp.inject({
    method: "GET",
    url: "/api/v1/autonomous/health",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(unauthorized.statusCode, 403);
  await unauthorizedApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const run = await services.autonomousRuns.accept({
    idempotencyKey: "health-test-run",
    productId: "11111111-1111-4111-8111-111111111111",
    offerId: "22222222-2222-4222-8222-222222222222",
  });
  await services.autonomousRuns.transition(run.id, "processing");
  await services.autonomousRuns.transition(run.id, "failed", { error: "health-test-failure" });

  const response = await operatorApp.inject({
    method: "GET",
    url: "/api/v1/autonomous/health",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "disabled");
  assert.equal(body.scheduler.running, false);
  assert.equal(body.runs.accepted, 0);
  assert.equal(body.runs.processing, 0);
  assert.equal(body.runs.failed, 1);
  assert.equal(body.runs.recoverable, 0);
  assert.ok(Array.isArray(body.publishers));
  await operatorApp.close();
});

test("GET /api/v1/autonomous/status requires an authorized operator", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();

  const viewerApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const viewerResponse = await viewerApp.inject({
    method: "GET",
    url: "/api/v1/autonomous/status",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(viewerResponse.statusCode, 403);
  assert.equal(viewerResponse.json().error, "FORBIDDEN");
  await viewerApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const operatorResponse = await operatorApp.inject({
    method: "GET",
    url: "/api/v1/autonomous/status",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(operatorResponse.statusCode, 200);
  assert.equal(operatorResponse.json().active, false);
  await operatorApp.close();
});


test("GET /api/v1/social-accounts requires an authorized operator", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();

  const publicApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const publicResponse = await publicApp.inject({ method: "GET", url: "/api/v1/social-accounts" });
  assert.equal(publicResponse.statusCode, 401);
  await publicApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const operatorResponse = await operatorApp.inject({
    method: "GET",
    url: "/api/v1/social-accounts",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(operatorResponse.statusCode, 200);
  assert.ok(Array.isArray(operatorResponse.json().data));
  await operatorApp.close();
});


test("GET /api/v1/social-accounts/:socialAccountId requires an authorized operator", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();
  const account = await services.socialAccounts.create({
    platform: "instagram",
    accountReference: "instagram-account",
    credentialReference: "secret://social/instagram",
  });

  const publicApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const publicResponse = await publicApp.inject({
    method: "GET",
    url: `/api/v1/social-accounts/${account.id}`,
  });
  assert.equal(publicResponse.statusCode, 401);
  await publicApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const operatorResponse = await operatorApp.inject({
    method: "GET",
    url: `/api/v1/social-accounts/${account.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(operatorResponse.statusCode, 200);
  assert.equal(operatorResponse.json().id, account.id);
  assert.equal("credentialReference" in operatorResponse.json(), false);
  assert.equal(operatorResponse.json().hasCredentialReference, true);
  await operatorApp.close();
});


test("GET /api/v1/autonomous/performance-index requires an authorized operator", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();

  const unauthenticatedApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "viewer", role: "viewer" },
  });
  const unauthenticated = await unauthenticatedApp.inject({ method: "GET", url: "/api/v1/autonomous/performance-index" });
  assert.equal(unauthenticated.statusCode, 401);
  await unauthenticatedApp.close();

  const operatorApp = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  const response = await operatorApp.inject({
    method: "GET",
    url: "/api/v1/autonomous/performance-index",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray((response.json() as { data: unknown[] }).data));
  await operatorApp.close();
});


test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv imports valid Shopee CSV rows", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "CSV Import Partner", email: "csv-import@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '123,"Produk CSV","37,5RB","10RB+","Toko Uji","4,5%","Rp1.500","https://shopee.co.id/product/1/123","https://s.shopee.co.id/abc123"',
  ].join("\n");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv, sourceReference: "test-export.csv" },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.importedProducts, 1);
  assert.equal(body.importedOffers, 1);
  assert.equal(body.csv.rowsParsed, 1);
  assert.deepEqual(body.csv.errors, []);
  const productsResponse = await app.inject({ method: "GET", url: "/api/v1/products" });
  assert.equal(productsResponse.statusCode, 200);
  assert.equal(productsResponse.json().data.length, 1);
  assert.equal(productsResponse.json().data[0].externalProductId, "123");
  const offersResponse = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(offersResponse.statusCode, 200);
  assert.equal(offersResponse.json().data.length, 1);
  assert.equal(offersResponse.json().data[0].affiliateUrl, "https://s.shopee.co.id/abc123");
  assert.equal(offersResponse.json().data[0].commissionRateBps, 450);
  assert.equal(productsResponse.json().data[0].priceCents, 3750000);
  assert.equal(offersResponse.json().data[0].commissionAmountCents, 150000);
  await app.close();
});

test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv rejects commission above price before persisting anything", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "CSV Commission Guard", email: "csv-commission-guard@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '987,"Komisi Tidak Valid","10RB","12","Toko Uji","5%","Rp12.000","https://shopee.co.id/product/1/987","https://s.shopee.co.id/invalid987"',
  ].join("\n");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv, sourceReference: "invalid-commission.csv" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_SHOPEE_AFFILIATE_CSV");
  assert.match(response.json().errors[0].message, /Komisi tidak boleh melebihi harga produk/);
  const products = await app.inject({ method: "GET", url: "/api/v1/products" });
  const offers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(products.json().data.length, 0);
  assert.equal(offers.json().data.length, 0);
  await app.close();
});

test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv rejects invalid CSV without importing rows", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "CSV Invalid Partner", email: "csv-invalid@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv: "ID Produk,Nama Produk\n123,Produk" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_SHOPEE_AFFILIATE_CSV");
  const productsResponse = await app.inject({ method: "GET", url: "/api/v1/products" });
  assert.equal(productsResponse.json().data.length, 0);
  const offersResponse = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(offersResponse.json().data.length, 0);
  await app.close();
});


test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv is idempotent for repeated files", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "CSV Idempotency Partner", email: "csv-idempotency@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '456,"Produk Idempoten","125RB","20","Toko Uji","5%","Rp2.000","https://shopee.co.id/product/1/456","https://s.shopee.co.id/idempotent456"',
  ].join("\n");
  const request = {
    method: "POST" as const,
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv, sourceReference: "repeat-export.csv" },
  };

  const firstImport = await app.inject(request);
  assert.equal(firstImport.statusCode, 201);
  const firstProducts = await app.inject({ method: "GET", url: "/api/v1/products" });
  const firstOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(firstProducts.json().data.length, 1);
  assert.equal(firstOffers.json().data.length, 1);
  const firstProductId = firstProducts.json().data[0].id;
  const firstOfferId = firstOffers.json().data[0].id;

  const secondImport = await app.inject(request);
  assert.equal(secondImport.statusCode, 201);
  const secondProducts = await app.inject({ method: "GET", url: "/api/v1/products" });
  const secondOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(secondProducts.json().data.length, 1, "re-import must not duplicate products");
  assert.equal(secondOffers.json().data.length, 1, "re-import must not duplicate affiliate offers");
  assert.equal(secondProducts.json().data[0].id, firstProductId, "re-import must retain product identity");
  assert.equal(secondOffers.json().data[0].id, firstOfferId, "re-import must retain offer identity");
  assert.equal(secondOffers.json().data[0].affiliateUrl, "https://s.shopee.co.id/idempotent456");
  await app.close();
});


test("CSV import reuses the canonical offer created by the JSON feed import", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "Cross Format Partner", email: "cross-format@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const productUrl = "https://shopee.co.id/product/1/456";
  const affiliateUrl = "https://s.shopee.co.id/crossformat456";

  const jsonImport = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import",
    payload: {
      affiliateId: affiliate.id,
      items: [{
        externalProductId: "456",
        name: "Produk Sama",
        priceCents: 12500000,
        currency: "IDR",
        productUrl,
        affiliateUrl,
        availability: "unknown",
        commissionRateBps: 500,
        commissionAmountCents: 200000,
      }],
    },
  });
  assert.equal(jsonImport.statusCode, 201);
  const initialOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(initialOffers.json().data.length, 1);
  const originalOfferId = initialOffers.json().data[0].id;
  assert.equal(initialOffers.json().data[0].externalOfferId, "feed:456");

  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '456,"Produk Sama","125RB","20","Toko Uji","5%","Rp2.000","https://shopee.co.id/product/1/456","https://s.shopee.co.id/crossformat456"',
  ].join("\n");
  const csvImport = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv, sourceReference: "cross-format.csv" },
  });
  assert.equal(csvImport.statusCode, 201);
  const finalProducts = await app.inject({ method: "GET", url: "/api/v1/products" });
  const finalOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(finalProducts.json().data.length, 1, "cross-format import must not duplicate products");
  assert.equal(finalOffers.json().data.length, 1, "cross-format import must not duplicate affiliate offers");
  assert.equal(finalOffers.json().data[0].id, originalOfferId, "cross-format import must retain offer identity");
  assert.equal(finalOffers.json().data[0].affiliateUrl, affiliateUrl);
  await app.close();
});

test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv creates a separate account for a different affiliate", async () => {
  const app = createApp();
  const firstAffiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "Original CSV Partner", email: "original-csv-partner@example.com" },
  });
  const secondAffiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "Different CSV Partner", email: "different-csv-partner@example.com" },
  });
  assert.equal(firstAffiliateResponse.statusCode, 201);
  assert.equal(secondAffiliateResponse.statusCode, 201);
  const firstAffiliate = firstAffiliateResponse.json();
  const secondAffiliate = secondAffiliateResponse.json();
  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '789,"Produk Kepemilikan","50RB","12","Toko Uji","4%","Rp1.000","https://shopee.co.id/product/1/789","https://s.shopee.co.id/owner789"',
  ].join("\n");

  const importFor = (affiliateId: string, sourceReference: string) => app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId, csv, sourceReference },
  });
  const firstImport = await importFor(firstAffiliate.id, "owner-export.csv");
  assert.equal(firstImport.statusCode, 201);

  const beforeOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(beforeOffers.json().data.length, 1);
  const originalOffer = beforeOffers.json().data[0];

  const secondImport = await importFor(secondAffiliate.id, "other-owner-export.csv");
  assert.equal(secondImport.statusCode, 201);

  const afterOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(afterOffers.json().data.length, 2);
  const retainedOriginal = afterOffers.json().data.find((offer: { id: string }) => offer.id === originalOffer.id);
  const newOffer = afterOffers.json().data.find((offer: { id: string }) => offer.id !== originalOffer.id);
  assert.deepEqual(retainedOriginal, originalOffer, "the original affiliate offer must remain unchanged");
  assert.ok(newOffer);
  assert.notEqual(newOffer.affiliateAccountId, originalOffer.affiliateAccountId, "the second affiliate must get a separate marketplace account");

  const verification = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers/verification" });
  assert.equal(verification.statusCode, 200);
  const verifiedOriginal = verification.json().data.find((offer: { id: string }) => offer.id === originalOffer.id);
  const verifiedNew = verification.json().data.find((offer: { id: string }) => offer.id === newOffer.id);
  assert.equal(verifiedOriginal.affiliateId, firstAffiliate.id);
  assert.equal(verifiedNew.affiliateId, secondAffiliate.id);
  await app.close();
});

test("POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv returns 400 for malformed CSV quoting", async () => {
  const app = createApp();
  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '987,"Produk"ekstra,10RB,12,Toko,5%,Rp500,https://shopee.co.id/product/1/987,https://s.shopee.co.id/malformed987',
  ].join("\n");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: "00000000-0000-4000-8000-000000000001", csv, sourceReference: "malformed.csv" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_SHOPEE_AFFILIATE_CSV");
  assert.match(response.json().message, /karakter setelah tanda kutip penutup/);
  const products = await app.inject({ method: "GET", url: "/api/v1/products" });
  const offers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(products.json().data.length, 0);
  assert.equal(offers.json().data.length, 0);
  await app.close();
});



test("CSV import adopts an existing legacy csv-prefixed offer instead of duplicating it", async () => {
  const app = createApp();
  const affiliateResponse = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "Legacy CSV Partner", email: "legacy-csv-partner@example.com" },
  });
  assert.equal(affiliateResponse.statusCode, 201);
  const affiliate = affiliateResponse.json();
  const productUrl = "https://shopee.co.id/product/1/456";
  const affiliateUrl = "https://s.shopee.co.id/legacy456";

  const legacyImport = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import",
    payload: {
      affiliateId: affiliate.id,
      items: [{
        externalProductId: "456",
        externalOfferId: "csv:456",
        name: "Produk Legacy",
        priceCents: 12500000,
        currency: "IDR",
        productUrl,
        affiliateUrl,
        availability: "unknown",
        commissionRateBps: 500,
        commissionAmountCents: 200000,
      }],
    },
  });
  assert.equal(legacyImport.statusCode, 201);
  const initialOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(initialOffers.json().data.length, 1);
  const legacyOfferId = initialOffers.json().data[0].id;

  const csv = [
    "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
    '456,"Produk Legacy","125RB","20","Toko Uji","5%","Rp2.000","https://shopee.co.id/product/1/456","https://s.shopee.co.id/legacy456"',
  ].join("\n");
  const csvImport = await app.inject({
    method: "POST",
    url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
    payload: { affiliateId: affiliate.id, csv, sourceReference: "legacy-export.csv" },
  });
  assert.equal(csvImport.statusCode, 201);

  const finalProducts = await app.inject({ method: "GET", url: "/api/v1/products" });
  const finalOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
  assert.equal(finalProducts.json().data.length, 1);
  assert.equal(finalOffers.json().data.length, 1, "legacy offer must be reused, not duplicated");
  assert.equal(finalOffers.json().data[0].id, legacyOfferId);
  assert.equal(finalOffers.json().data[0].externalOfferId, "feed:456", "legacy identifier should be canonicalized");
  assert.equal(finalOffers.json().data[0].affiliateUrl, affiliateUrl);
  await app.close();
});


test("Shopee CSV import leaves both canonical and legacy Shopee offers intact", async () => {
  const app = createApp();
  try {
    const affiliateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/affiliates",
      payload: { name: "Dual Offer Partner", email: "dual-offer@example.com" },
    });
    assert.equal(affiliateResponse.statusCode, 201);
    const affiliate = affiliateResponse.json();
    const productUrl = "https://shopee.co.id/product/1/987";
    const affiliateUrl = "https://s.shopee.co.id/abc987";
    const seed = await app.inject({
      method: "POST",
      url: "/api/v1/marketplaces/shopee-affiliate-feed/import",
      payload: {
        affiliateId: affiliate.id,
        items: [
          { externalProductId: "987", externalOfferId: "feed:987", name: "Produk Kanonis", priceCents: 3750000, currency: "IDR", productUrl, affiliateUrl, commissionRateBps: 450, commissionAmountCents: 150000, availability: "unknown" },
          { externalProductId: "987", externalOfferId: "csv:987", name: "Produk Legacy", priceCents: 3750000, currency: "IDR", productUrl, affiliateUrl, commissionRateBps: 450, commissionAmountCents: 150000, availability: "unknown" },
        ],
      },
    });
    assert.equal(seed.statusCode, 201);
    const before = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().data.length, 2);
    const beforeByExternalId = new Map(before.json().data.map((offer: { externalOfferId: string; id: string }) => [offer.externalOfferId, offer.id]));

    const csv = [
      "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
      '"987","Produk Diperbarui","Rp37.500","10RB+","Toko Uji","4,5%","Rp1.500","https://shopee.co.id/product/1/987","https://s.shopee.co.id/abc987"',
    ].join("\n");
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
      payload: { affiliateId: affiliate.id, csv },
    });
    assert.equal(imported.statusCode, 201);

    const after = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().data.length, 2);
    const afterByExternalId = new Map(after.json().data.map((offer: { externalOfferId: string; id: string }) => [offer.externalOfferId, offer.id]));
    assert.equal(afterByExternalId.get("feed:987"), beforeByExternalId.get("feed:987"));
    assert.equal(afterByExternalId.get("csv:987"), beforeByExternalId.get("csv:987"));
  } finally {
    await app.close();
  }
});

test("GET TikTok creator info resolves the internal credential reference without exposing it", async () => {
  const token = "test-token-that-is-long-enough";
  const services = (await import("../../src/domain/container.js")).createInMemoryServices();
  const account = await services.socialAccounts.create({
    platform: "tiktok",
    accountReference: "tiktok-account",
    status: "active",
    credentialReference: "secret://social/tiktok",
  });
  let receivedCredentialReference: string | undefined;
  services.tiktokCreatorInfo.getCreatorInfo = async (providerAccount) => {
    receivedCredentialReference = providerAccount.credentialReference;
    return {
      creatorNickname: "Test creator",
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE"],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      maxVideoPostDurationSec: 60,
      canPostMore: true,
    };
  };
  const app = createApp(services, {
    auth: { enabled: true, token, operatorId: "operator", role: "operator" },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/social-accounts/${account.id}/tiktok/creator-info`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(receivedCredentialReference, "secret://social/tiktok");
    assert.deepEqual(response.json().privacyLevelOptions, ["PUBLIC_TO_EVERYONE"]);
    assert.equal(JSON.stringify(response.json()).includes("secret://social/tiktok"), false);
  } finally {
    await app.close();
  }
});

test("GET /api/v1/public/shop includes HTTPS product media and omits unsafe media URLs", async () => {
  const services = createInMemoryServices();
  const now = new Date().toISOString();
  const products = [
    {
      id: "product-with-media",
      referenceNumber: 1,
      marketplaceId: "marketplace-test",
      externalProductId: "external-1",
      name: "Product with media",
      category: "Test",
      priceCents: 10000,
      currency: "IDR",
      ratingMilli: 5000,
      reviewCount: 10,
      soldCount: 20,
      imageUrl: "https://cdn.example.com/product.jpg",
      videoUrl: "https://cdn.example.com/product.mp4",
      productUrl: "https://shop.example.com/product/1",
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "product-with-unsafe-media",
      referenceNumber: 2,
      marketplaceId: "marketplace-test",
      externalProductId: "external-2",
      name: "Product with unsafe media",
      category: "Test",
      priceCents: 20000,
      currency: "IDR",
      ratingMilli: 4900,
      reviewCount: 5,
      soldCount: 8,
      imageUrl: "http://cdn.example.com/product.jpg",
      videoUrl: "javascript:alert(1)",
      productUrl: "https://shop.example.com/product/2",
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "product-with-private-media",
      referenceNumber: 3,
      marketplaceId: "marketplace-test",
      externalProductId: "external-3",
      name: "Product with private media",
      category: "Test",
      priceCents: 30000,
      currency: "IDR",
      ratingMilli: 4800,
      reviewCount: 3,
      soldCount: 4,
      imageUrl: "https://127.0.0.1/private.jpg",
      videoUrl: "https://media.local/private.mp4",
      productUrl: "https://shop.example.com/product/3",
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    }
  ];
  const offers = products.map((product, index) => ({
    id: `offer-${product.id}`,
    productId: product.id,
    status: "active",
    affiliateLinkStatus: "active",
    affiliateUrl: `https://affiliate.example.com/${index}`,
    priceCents: product.priceCents,
    currency: product.currency
  }));
  const trackingLinks = offers.map((offer, index) => ({
    id: `tracking-${index}`,
    affiliateOfferId: offer.id,
    status: "active",
    destinationUrl: offer.affiliateUrl,
    code: `track-${index}`
  }));

  services.marketplace.listProducts = async () => products;
  services.marketplace.listAffiliateOffers = async () => offers as never;
  services.tracking.list = async () => trackingLinks as never;

  const app = createApp(services);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/public/shop" });
    assert.equal(response.statusCode, 200);
    const items = response.json().data;
    assert.equal(items.length, 3);
    assert.equal(items[0].imageUrl, products[0].imageUrl);
    assert.equal(items[0].videoUrl, products[0].videoUrl);
    assert.equal(Object.hasOwn(items[1], "imageUrl"), false);
    assert.equal(Object.hasOwn(items[1], "videoUrl"), false);
    assert.equal(Object.hasOwn(items[2], "imageUrl"), false);
    assert.equal(Object.hasOwn(items[2], "videoUrl"), false);
  } finally {
    await app.close();
  }
});

