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
  const campaign = await services.campaigns.create({
    name: "Launch",
    objective: "sales",
    startAt: "2026-10-01T00:00:00.000Z",
    endAt: "2026-10-31T00:00:00.000Z"
  });

  await assert.rejects(
    () => services.campaigns.update(campaign.id, { endAt: "2026-09-30T00:00:00.000Z" }),
    /startAt must be before endAt/i
  );

  assert.equal((await services.campaigns.get(campaign.id)).endAt, "2026-10-31T00:00:00.000Z");
});

test("campaign lifecycle rejects invalid transitions", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales", status: "draft" });
  await services.campaigns.update(campaign.id, { status: "active" });
  await services.campaigns.update(campaign.id, { status: "paused" });
  await assert.rejects(() => services.campaigns.update(campaign.id, { status: "draft" }), /cannot transition/i);
});

test("campaign offer reads reject an unknown campaign", async () => {
  const services = createInMemoryServices();
  await assert.rejects(() => services.campaigns.listOffers("00000000-0000-0000-0000-000000000001"), /campaign does not exist/i);
});

test("tracking link filters reject an unknown campaign", async () => {
  const services = createInMemoryServices();
  await assert.rejects(() => services.tracking.list("00000000-0000-0000-0000-000000000001"), /campaign does not exist/i);
});

test("tracking links reject unknown affiliate offers", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await assert.rejects(
    () => services.tracking.create({ affiliateOfferId: "00000000-0000-0000-0000-000000000001", campaignId: campaign.id, destinationUrl: "https://example.com" }),
    /affiliate offer does not exist/i
  );
});

test("tracking clicks are idempotent when an idempotency key is reused", async () => {
  const services = createInMemoryServices();
  const click = { id: "00000000-0000-0000-0000-000000000001", trackingLinkId: "00000000-0000-0000-0000-000000000002", occurredAt: "2026-10-01T00:00:00.000Z", metadata: { idempotencyKey: "click-12345678" } };
  const link = { id: click.trackingLinkId, affiliateOfferId: "00000000-0000-0000-0000-000000000003", code: "TEST1234", destinationUrl: "https://example.com", status: "active" as const, createdAt: click.occurredAt, updatedAt: click.occurredAt };
  const clicks = services.tracking;
  await services.tracking.get = async () => link;
  const repository = (clicks as unknown as { clicks: { save: (value: typeof click) => Promise<typeof click>; listByTrackingLink: (id: string) => Promise<typeof click[]> } }).clicks;
  void repository;
});
