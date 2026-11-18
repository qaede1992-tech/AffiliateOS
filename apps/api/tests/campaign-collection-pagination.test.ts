import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign } from "@affiliateos/shared";
import { CampaignService } from "../src/domain/campaigns.js";
import { DomainError } from "../src/domain/errors.js";
import type { CampaignRepository, CampaignOfferRepository, AffiliateOfferRepository } from "../src/domain/repository.js";

const makeCampaign = (id: string): Campaign => ({ id, name: id, objective: "sales", status: "draft", audience: {}, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });

test("campaign history uses bounded cursor pages without loading the full collection", async () => {
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003"
  ];
  const calls: Array<{ afterId?: string; limit: number }> = [];
  const campaigns = {
    list: async () => { throw new Error("full collection must not be loaded"); },
    listPage: async (input: { afterId?: string; limit: number }) => {
      calls.push(input);
      return ids.filter((id) => !input.afterId || id > input.afterId).slice(0, input.limit).map(makeCampaign);
    },
    findById: async () => undefined,
    save: async (campaign: Campaign) => campaign
  } as unknown as CampaignRepository;
  const service = new CampaignService(campaigns, {} as CampaignOfferRepository, {} as AffiliateOfferRepository);
  const first = await service.listPage({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await service.listPage({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map((item) => item.id), ids.slice(2));
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(calls, [{ limit: 3 }, { afterId: ids[1], limit: 3 }]);
});

test("campaign history rejects malformed cursors", async () => {
  const campaigns = { list: async () => [], findById: async () => undefined, save: async (campaign: Campaign) => campaign } as unknown as CampaignRepository;
  const service = new CampaignService(campaigns, {} as CampaignOfferRepository, {} as AffiliateOfferRepository);
  await assert.rejects(() => service.listPage({ limit: 25, cursor: "not-a-cursor" }), (error: unknown) => error instanceof DomainError && error.code === "INVALID_CAMPAIGN_COLLECTION_CURSOR");
});
