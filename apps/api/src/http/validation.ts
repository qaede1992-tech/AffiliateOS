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
  commissionRateBps: z.number().int().min(0).max(10000)
});

export const createConversionSchema = z.object({
  affiliateId: entityId,
  offerId: entityId,
  amountCents: z.number().int().positive(),
  occurredAt: isoTimestamp.optional()
});