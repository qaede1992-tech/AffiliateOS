import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign, Content, Product } from "@affiliateos/shared";
import { ContentService } from "../src/domain/content.js";
import { InMemoryRepository } from "../src/domain/repository.js";

test("content pages are bounded, stable, and preserve campaign filtering", async () => {
  const contents = new InMemoryRepository<Content>();
  const campaigns = new InMemoryRepository<Campaign>();
  const products = new InMemoryRepository<Product>();
  const service = new ContentService(contents, campaigns, products);
  const createdAt = "2026-01-01T00:00:00.000Z";
  await campaigns.save({ id: "00000000-0000-4000-8000-000000000001", name: "Campaign", objective: "traffic", status: "draft", audience: {}, createdAt, updatedAt: createdAt });
  for (let index = 1; index <= 3; index++) {
    await contents.save({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      campaignId: index < 3 ? "00000000-0000-4000-8000-000000000001" : undefined,
      platform: "instagram", contentType: "short-form", status: "draft", createdAt, updatedAt: createdAt
    });
  }

  const first = await service.listPage({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await service.listPage({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.id, second.items[0]?.id);

  const campaignPage = await service.listPage({ limit: 10, campaignId: "00000000-0000-4000-8000-000000000001" });
  assert.equal(campaignPage.items.length, 2);
  assert.equal(campaignPage.hasMore, false);
});
