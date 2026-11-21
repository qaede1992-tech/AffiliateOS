import assert from "node:assert/strict";
import test from "node:test";
import { MarketplaceService } from "../src/domain/marketplace.js";
import { MarketplaceProviderRegistry } from "../src/domain/foundations.js";
import { createPostgresRepositories } from "../src/db/repositories.js";
import {
  affiliateAccounts,
  affiliateOffers,
  affiliates,
  marketplaces,
  products
} from "../src/db/schema.js";

const offerRow = {
  id: "00000000-0000-4000-8000-000000000101",
  productId: "00000000-0000-4000-8000-000000000102",
  conversionOfferId: null,
  affiliateAccountId: "00000000-0000-4000-8000-000000000103",
  externalOfferId: "external-offer-1",
  priceCents: 125000,
  currency: "IDR",
  commissionRateBps: 500,
  commissionAmountCents: 6250,
  availability: "available",
  availabilityMetadata: {},
  affiliateUrl: "https://affiliate.example.test/offer-1",
  affiliateLinkExpiresAt: null,
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z"
};

const joinedRow = {
  offer: offerRow,
  affiliateId: "00000000-0000-4000-8000-000000000104",
  affiliateName: "Affiliate One",
  affiliateAccountName: "Primary account",
  marketplaceSlug: "shopee-affiliate-feed",
  productExternalId: "product-1",
  productName: "Product One",
  productUrl: "https://shop.example.test/product-1"
};

test("affiliate offer verification uses one ordered query with the required joins", async () => {
  let selectCount = 0;
  let selectedTable: unknown;
  const joinedTables: unknown[] = [];
  let orderByCount = 0;

  const db = {
    select(selection: Record<string, unknown>) {
      selectCount += 1;
      assert.deepEqual(Object.keys(selection), [
        "offer",
        "affiliateId",
        "affiliateName",
        "affiliateAccountName",
        "marketplaceSlug",
        "productExternalId",
        "productName",
        "productUrl"
      ]);
      return {
        from(table: unknown) {
          selectedTable = table;
          return {
            leftJoin(tableToJoin: unknown) {
              joinedTables.push(tableToJoin);
              return this;
            },
            where() { return this; },
            orderBy() {
              orderByCount += 1;
              return this;
            },
            async limit(value: number) {
              assert.equal(value, 26);
              return [joinedRow];
            }
          };
        }
      };
    }
  };

  const repositories = createPostgresRepositories(db as never);
  const rows = await repositories.affiliateOffers.listVerificationRows?.({ limit: 26 });

  assert.equal(selectCount, 1);
  assert.equal(selectedTable, affiliateOffers);
  assert.deepEqual(joinedTables, [affiliateAccounts, affiliates, marketplaces, products]);
  assert.equal(orderByCount, 1);
  assert.deepEqual(rows, [{
    id: offerRow.id,
    productId: offerRow.productId,
    conversionOfferId: undefined,
    affiliateAccountId: offerRow.affiliateAccountId,
    externalOfferId: offerRow.externalOfferId,
    priceCents: offerRow.priceCents,
    currency: offerRow.currency,
    commissionRateBps: offerRow.commissionRateBps,
    commissionAmountCents: offerRow.commissionAmountCents,
    availability: offerRow.availability,
    availabilityMetadata: offerRow.availabilityMetadata,
    affiliateUrl: offerRow.affiliateUrl,
    affiliateLinkExpiresAt: undefined,
    affiliateLinkStatus: offerRow.affiliateLinkStatus,
    status: offerRow.status,
    createdAt: offerRow.createdAt,
    updatedAt: offerRow.updatedAt,
    affiliateId: joinedRow.affiliateId,
    affiliateName: joinedRow.affiliateName,
    affiliateAccountName: joinedRow.affiliateAccountName,
    marketplaceSlug: joinedRow.marketplaceSlug,
    productExternalId: joinedRow.productExternalId,
    productName: joinedRow.productName,
    productUrl: joinedRow.productUrl
  }]);
});

test("marketplace verification service prefers the joined repository path", async () => {
  const expected = [{ ...joinedRow.offer, affiliateId: joinedRow.affiliateId, affiliateName: joinedRow.affiliateName }];
  let joinedReadCount = 0;
  let fallbackReadCount = 0;
  const offers = {
    async listVerificationRows(input: { after?: { createdAt: string; id: string }; limit: number }) {
      joinedReadCount += 1;
      assert.equal(input.limit, 26);
      return expected;
    },
    async list() {
      fallbackReadCount += 1;
      throw new Error("N+1 fallback must not run when joined rows are available");
    }
  };

  const service = new MarketplaceService(
    new MarketplaceProviderRegistry(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    offers as never,
    {} as never
  );

  const page = await service.listAffiliateOfferVerification({ limit: 25 });
  assert.deepEqual(page.items, expected);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(joinedReadCount, 1);
  assert.equal(fallbackReadCount, 0);
});
