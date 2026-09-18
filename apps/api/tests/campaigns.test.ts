import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryServices } from "../src/domain/container.js";

test("campaign creation persists in the service repository", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  assert.equal((await services.campaigns.get(campaign.id)).name, "Launch");
});

test("campaign updates preserve the start/end date invariant", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-31T00:00:00.000Z" });
  await assert.rejects(() => services.campaigns.update(campaign.id, { endAt: "2026-09-30T00:00:00.000Z" }), /startAt must be before endAt/i);
  assert.equal((await services.campaigns.get(campaign.id)).endAt, "2026-10-31T00:00:00.000Z");
});

test("campaign status follows the lifecycle transition rules", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await services.campaigns.update(campaign.id, { status: "active" });
  await assert.rejects(() => services.campaigns.update(campaign.id, { status: "draft" }), /cannot change campaign status/i);
});

test("campaign offer attachment rejects unknown affiliate offers", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await assert.rejects(
    () => services.campaigns.attachOffer(campaign.id, "10000000-0000-0000-0000-000000000099"),
    /affiliate offer does not exist/i
  );
});

test("tracking links reject unknown affiliate offers", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await assert.rejects(
    () => services.tracking.create({ affiliateOfferId: "10000000-0000-0000-0000-000000000001", campaignId: campaign.id, destinationUrl: "https://example.com" }),
    /affiliate offer does not exist/i
  );
});
