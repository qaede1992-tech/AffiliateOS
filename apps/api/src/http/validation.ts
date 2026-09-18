import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const entityId = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });

export const createAffiliateSchema = z.object({
  name: nonEmptyText.max(200),
  email: z.string().email().max(320)
});

export const createOfferSchema = z.object({
  name: nonEmptyText.max(200),
  status: z.enum(["active", "inactive"]),
  commissionRateBps: z.number().int().min(0).max(10000)
});

export const createConversionSchema = z.object({
  affiliateId: entityId,
  offerId: entityId,
  amountCents: z.number().int().positive(),
  occurredAt: isoTimestamp.optional()
});
export const scoreProductSchema = z.object({
  product: z.object({
    id: entityId, marketplaceId: entityId, externalProductId: nonEmptyText.max(255), name: nonEmptyText.max(500),
    description: z.string().max(10000).optional(), category: z.string().max(255).optional(), priceCents: z.number().int().nonnegative(), originalPriceCents: z.number().int().nonnegative().optional(), currency: z.string().length(3), ratingMilli: z.number().int().min(0).max(5000).optional(), reviewCount: z.number().int().nonnegative(), soldCount: z.number().int().nonnegative(), imageUrl: z.string().url().optional(), productUrl: z.string().url(), status: z.enum(["active", "inactive", "archived"]), createdAt: isoTimestamp, updatedAt: isoTimestamp
  }),
  commissionRateBps: z.number().int().min(0).max(10000).default(0), audienceRelevance: z.number().min(0).max(1).default(0)
});
