import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("campaign HTTP endpoints support create, get, list, update, and lifecycle validation", async () => {
  const app = createApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v1/campaigns",
    payload: {
      name: "Lifecycle campaign",
      objective: "sales",
      status: "draft",
      startAt: "2026-10-01T00:00:00.000Z",
      endAt: "2026-10-31T00:00:00.000Z",
      audience: { segment: "deal-hunters" }
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const campaign = createResponse.json();
  assert.equal(campaign.name, "Lifecycle campaign");
  assert.equal(campaign.status, "draft");

  const getResponse = await app.inject({
    method: "GET",
    url: `/api/v1/campaigns/${campaign.id}`
  });
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.json().id, campaign.id);

  const listResponse = await app.inject({ method: "GET", url: "/api/v1/campaigns" });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().data.length, 1);

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/api/v1/campaigns/${campaign.id}`,
    payload: { status: "active", objective: "conversion" }
  });
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.json().status, "active");
  assert.equal(updateResponse.json().objective, "conversion");

  const invalidTransition = await app.inject({
    method: "PATCH",
    url: `/api/v1/campaigns/${campaign.id}`,
    payload: { status: "draft" }
  });
  assert.equal(invalidTransition.statusCode, 400);
  assert.equal(invalidTransition.json().error, "INVALID_CAMPAIGN_TRANSITION");

  const invalidDates = await app.inject({
    method: "POST",
    url: "/api/v1/campaigns",
    payload: {
      name: "Invalid dates",
      objective: "sales",
      startAt: "2026-10-31T00:00:00.000Z",
      endAt: "2026-10-01T00:00:00.000Z"
    }
  });
  assert.equal(invalidDates.statusCode, 400);
  assert.equal(invalidDates.json().error, "VALIDATION_ERROR");

  await app.close();
});

test("campaign HTTP offer and tracking routes validate missing resources", async () => {
  const app = createApp();
  const missingId = "00000000-0000-4000-8000-000000000999";

  const offersResponse = await app.inject({
    method: "GET",
    url: `/api/v1/campaigns/${missingId}/offers`
  });
  assert.equal(offersResponse.statusCode, 404);
  assert.equal(offersResponse.json().error, "CAMPAIGN_NOT_FOUND");

  const trackingResponse = await app.inject({
    method: "GET",
    url: `/api/v1/tracking-links?campaignId=${missingId}`
  });
  assert.equal(trackingResponse.statusCode, 404);
  assert.equal(trackingResponse.json().error, "CAMPAIGN_NOT_FOUND");

  const linkResponse = await app.inject({
    method: "POST",
    url: "/api/v1/tracking-links",
    payload: {
      affiliateOfferId: missingId,
      destinationUrl: "https://example.com/landing"
    }
  });
  assert.equal(linkResponse.statusCode, 404);
  assert.equal(linkResponse.json().error, "AFFILIATE_OFFER_NOT_FOUND");

  await app.close();
});
