import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("content HTTP endpoints support create, filter, get, update, and validation", async () => {
  const app = createApp();
  const campaignResponse = await app.inject({ method: "POST", url: "/api/v1/campaigns", payload: { name: "Content campaign", objective: "sales" } });
  const campaign = campaignResponse.json();
  const createResponse = await app.inject({ method: "POST", url: "/api/v1/content", payload: { campaignId: campaign.id, platform: "instagram", contentType: "post", title: "Launch", caption: "Details", cta: "Learn more" } });
  assert.equal(createResponse.statusCode, 201);
  const content = createResponse.json();
  assert.equal(content.status, "draft");
  const filtered = await app.inject({ method: "GET", url: `/api/v1/content?campaignId=${campaign.id}` });
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.json().data.length, 1);
  const getResponse = await app.inject({ method: "GET", url: `/api/v1/content/${content.id}` });
  assert.equal(getResponse.statusCode, 200);
  const scheduled = await app.inject({ method: "PATCH", url: `/api/v1/content/${content.id}`, payload: { status: "scheduled", scheduledAt: "2026-10-01T10:00:00.000Z" } });
  assert.equal(scheduled.statusCode, 200);
  assert.equal(scheduled.json().status, "scheduled");
  const invalid = await app.inject({ method: "PATCH", url: `/api/v1/content/${content.id}`, payload: { status: "draft" } });
  assert.equal(invalid.statusCode, 200);
  assert.equal(invalid.json().status, "draft");
  await app.close();
});

test("social account HTTP endpoints never expose credential references", async () => {
  const app = createApp();
  const createResponse = await app.inject({ method: "POST", url: "/api/v1/social-accounts", payload: { platform: "instagram", accountReference: "creator-1", credentialReference: "vault://social/creator-1" } });
  assert.equal(createResponse.statusCode, 201);
  const account = createResponse.json();
  assert.equal(account.hasCredentialReference, true);
  assert.equal("credentialReference" in account, false);
  const listResponse = await app.inject({ method: "GET", url: "/api/v1/social-accounts" });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().data[0].hasCredentialReference, true);
  const duplicate = await app.inject({ method: "POST", url: "/api/v1/social-accounts", payload: { platform: "instagram", accountReference: "creator-1" } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error, "SOCIAL_ACCOUNT_EXISTS");
  await app.close();
});
