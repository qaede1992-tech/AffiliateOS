import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryServices } from "../src/domain/container.js";

test("content can be created, listed by campaign, and transitioned", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Content campaign", objective: "sales" });
  const content = await services.content.create({ campaignId: campaign.id, platform: "instagram", contentType: "post", title: "Draft", caption: "Product details", cta: "Learn more" });
  assert.equal((await services.content.list(campaign.id)).length, 1);
  await assert.rejects(() => services.content.update(content.id, { status: "scheduled" }), /requires scheduledAt/i);
  const scheduled = await services.content.update(content.id, { status: "scheduled", scheduledAt: "2026-10-01T10:00:00.000Z" });
  assert.equal(scheduled.status, "scheduled");
  const draft = await services.content.update(content.id, { status: "draft" });
  assert.equal(draft.status, "draft");
  const rescheduled = await services.content.update(content.id, { status: "scheduled", scheduledAt: "2026-10-01T10:00:00.000Z" });
  assert.equal(rescheduled.status, "scheduled");
  const published = await services.content.update(content.id, { status: "published", publishedAt: "2026-10-01T11:00:00.000Z" });
  assert.equal(published.status, "published");
});

test("content validates campaign and product references", async () => {
  const services = createInMemoryServices();
  await assert.rejects(() => services.content.create({ campaignId: "00000000-0000-0000-0000-000000000001", platform: "x", contentType: "post" }), /campaign does not exist/i);
  await assert.rejects(() => services.content.create({ productId: "00000000-0000-0000-0000-000000000002", platform: "x", contentType: "post" }), /product does not exist/i);
});

test("social accounts hide credential references from service responses", async () => {
  const services = createInMemoryServices();
  const account = await services.socialAccounts.create({ platform: "instagram", accountReference: "creator-1", credentialReference: "vault://social/creator-1" });
  assert.equal(account.hasCredentialReference, true);
  assert.equal("credentialReference" in account, false);
  const updated = await services.socialAccounts.update(account.id, { status: "active" });
  assert.equal(updated.status, "active");
  assert.equal((await services.socialAccounts.list()).length, 1);
});

test("social account connection metadata redacts sensitive values recursively", async () => {
  const services = createInMemoryServices();
  const account = await services.socialAccounts.create({
    platform: "instagram",
    accountReference: "creator-2",
    connection: {
      region: "ap-southeast-1",
      accessToken: "secret-access-token",
      nested: { api_key: "secret-api-key", label: "creator" },
      items: [{ refreshToken: "secret-refresh-token", name: "profile" }]
    }
  });

  assert.deepEqual(account.connection, {
    region: "ap-southeast-1",
    accessToken: "[REDACTED]",
    nested: { api_key: "[REDACTED]", label: "creator" },
    items: [{ refreshToken: "[REDACTED]", name: "profile" }]
  });
});

test("social account duplicate identity is rejected", async () => {
  const services = createInMemoryServices();
  await services.socialAccounts.create({ platform: "tiktok", accountReference: "creator-1" });
  await assert.rejects(() => services.socialAccounts.create({ platform: "tiktok", accountReference: "creator-1" }), /already registered/i);
});
