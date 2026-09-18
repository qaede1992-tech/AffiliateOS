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
    id: entityId,
    marketplaceId: entityId,
    externalProductId: nonEmptyText.max(255),
    name: nonEmptyText.max(500),
    description: z.string().max(10000).optional(),
    category: z.string().max(255).optional(),
    priceCents: z.number().int().nonnegative(),
    originalPriceCents: z.number().int().nonnegative().optional(),
    currency: z.string().length(3),
    ratingMilli: z.number().int().min(0).max(5000).optional(),
    reviewCount: z.number().int().nonnegative(),
    soldCount: z.number().int().nonnegative(),
    imageUrl: z.string().url().optional(),
    productUrl: z.string().url(),
    status: z.enum(["active", "inactive", "archived"]),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp
  }),
  commissionRateBps: z.number().int().min(0).max(10000).default(0),
  audienceRelevance: z.number().min(0).max(1).default(0)
});

export const marketplaceSlugSchema = z.object({ connectionSlug: z.string().trim().min(1).max(100) });
export const marketplaceProductParamsSchema = marketplaceSlugSchema.extend({ externalProductId: nonEmptyText.max(255) });
export const marketplaceSearchSchema = marketplaceSlugSchema.extend({ query: nonEmptyText.max(200) });
export const marketplaceLinkSchema = marketplaceProductParamsSchema.extend({ externalOfferId: nonEmptyText.max(255) });
const safeConfiguration = z.record(z.string(), z.unknown()).default({});
export const createMarketplaceConnectionSchema = z.object({ name: nonEmptyText.max(100), slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), providerSlug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), credentialReference: z.string().trim().min(3).max(255).optional(), configuration: safeConfiguration, enabled: z.boolean().default(false) });
export const updateMarketplaceConnectionSchema = z.object({ name: nonEmptyText.max(100).optional(), credentialReference: z.string().trim().min(3).max(255).optional(), configuration: safeConfiguration.optional() }).refine((value) => Object.keys(value).length > 0, "At least one connection field is required.");
export const marketplaceEnableSchema = z.object({ enabled: z.boolean() });

export const createCampaignSchema = z.object({
  name: nonEmptyText.max(200),
  objective: nonEmptyText.max(100),
  status: z.enum(["draft", "scheduled", "active", "paused", "completed", "archived"]).default("draft"),
  startAt: isoTimestamp.optional(),
  endAt: isoTimestamp.optional(),
  audience: z.record(z.string(), z.unknown()).default({})
}).refine((value) => !value.startAt || !value.endAt || value.startAt <= value.endAt, "startAt must be before endAt");

export const updateCampaignSchema = z.object({
  name: nonEmptyText.max(200).optional(),
  objective: nonEmptyText.max(100).optional(),
  status: z.enum(["draft", "scheduled", "active", "paused", "completed", "archived"]).optional(),
  startAt: isoTimestamp.optional(),
  endAt: isoTimestamp.optional(),
  audience: z.record(z.string(), z.unknown()).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one campaign field is required.");

export const campaignIdSchema = z.object({ campaignId: entityId });
export const campaignOfferParamsSchema = z.object({ campaignId: entityId, affiliateOfferId: entityId });
export const createTrackingLinkSchema = z.object({
  affiliateOfferId: entityId,
  campaignId: entityId.optional(),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{4,100}$/).optional(),
  destinationUrl: z.string().url().max(2048)
});
export const trackingLinkIdSchema = z.object({ trackingLinkId: entityId });
export const recordClickSchema = z.object({ occurredAt: isoTimestamp.optional(), metadata: z.record(z.string(), z.unknown()).default({}) });
