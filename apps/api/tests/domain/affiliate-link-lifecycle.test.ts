import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAffiliateLinkExpired } from "../../src/domain/marketplace.js";

const offer = (expiresAt?: string) => ({
  id: "offer",
  productId: "product",
  affiliateAccountId: "account",
  availability: "in_stock" as const,
  availabilityMetadata: {},
  affiliateUrl: "https://example.com/affiliate",
  affiliateLinkStatus: "active" as const,
  affiliateLinkMetadata: expiresAt ? { expiresAt } : undefined,
  status: "active" as const,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z"
});

describe("affiliate link lifecycle", () => {
  it("keeps an unexpired link active", () => {
    assert.equal(isAffiliateLinkExpired(offer("2026-09-22T00:00:00.000Z"), "2026-09-21T12:00:00.000Z"), false);
  });

  it("detects an expired link deterministically", () => {
    assert.equal(isAffiliateLinkExpired(offer("2026-09-21T12:00:00.000Z"), "2026-09-21T12:00:00.000Z"), true);
  });

  it("treats a link without expiry metadata as non-expired", () => {
    assert.equal(isAffiliateLinkExpired(offer(), "2026-09-21T12:00:00.000Z"), false);
  });
});
