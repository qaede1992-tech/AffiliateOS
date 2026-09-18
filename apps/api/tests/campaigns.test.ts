import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryServices } from "../src/domain/container.js";

test("campaign creation persists in the service repository", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  assert.equal((await services.campaigns.get(campaign.id)).name, "Launch");
});

test("tracking links reject unknown affiliate offers", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await assert.rejects(
    () => services.tracking.create({ affiliateOfferId: "00000000-0000-0000-0000-000000000001", campaignId: campaign.id, destinationUrl: "https://example.com" }),
    /affiliate offer does not exist/i
  );
});
