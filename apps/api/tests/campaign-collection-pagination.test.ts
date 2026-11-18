import assert from "node:assert/strict";
import test from "node:test";
import { CampaignService } from "../src/domain/campaigns.js";
import { DomainError } from "../src/domain/errors.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const campaigns = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Alpha", objective: "test", status: "draft", audience: {}, createdAt, updatedAt: createdAt },
  { id: "00000000-0000-4000-8000-000000000002", name: "Beta", objective: "test", status: "draft", audience: {}, createdAt, updatedAt: createdAt },
  { id: "00000000-0000-4000-8000-000000000003", name: "Gamma", objective: "test", status: "draft", audience: {}, createdAt, updatedAt: createdAt }
];

test("campaign history pages are bounded, stable, and cursor-continuable", async () => {
  let requestedLimit = 0;
  const repository = {
    list: async () => campaigns,
    listPage: async ({ afterId, limit }: { afterId?: string; limit: number }) => {
      requestedLimit = limit;
      return campaigns.filter((campaign) => !afterId || campaign.id > afterId).slice(0, limit);
    },
    findById: async () => undefined,
    save: async (campaign: unknown) => campaign
  };
  const service = new CampaignService(repository as never, {} as never, {} as never);
  const first = await service.listPage({ limit: 2 });
  assert.equal(requestedLimit, 3);
  assert.deepEqual(first.items.map((campaign) => campaign.name), ["Alpha", "Beta"]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await service.listPage({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map((campaign) => campaign.name), ["Gamma"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("campaign history rejects malformed cursors", async () => {
  const service = new CampaignService({ list: async () => [], findById: async () => undefined, save: async (value: unknown) => value } as never, {} as never, {} as never);
  await assert.rejects(() => service.listPage({ limit: 25, cursor: "not-a-cursor" }), (error: unknown) => error instanceof DomainError && error.code === "INVALID_CAMPAIGN_COLLECTION_CURSOR");
});
