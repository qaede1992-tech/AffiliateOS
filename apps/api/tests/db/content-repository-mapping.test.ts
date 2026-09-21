import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toContent } from "../../src/db/repositories.js";

describe("content database mapping", () => {
  it("preserves the persisted social account binding", () => {
    const content = toContent({
      id: "content-1",
      productId: null,
      campaignId: null,
      socialAccountId: "social-account-1",
      platform: "tiktok",
      contentType: "affiliate-promotion",
      title: null,
      caption: "caption",
      script: null,
      cta: "shop now",
      status: "scheduled",
      scheduledAt: "2026-09-20T12:00:00.000Z",
      publishedAt: null,
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z"
    } as any);

    assert.equal(content.socialAccountId, "social-account-1");
  });
});
