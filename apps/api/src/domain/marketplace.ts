

function validateMarketplaceOfferInput(input: import("@affiliateos/shared").MarketplaceOfferInput): void {
  if (!input.externalOfferId.trim()) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace offers require an external offer id.", 400);
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace offer price must be a non-negative integer.", 400);
  if (input.currency !== undefined && !/^[A-Za-z]{3}$/.test(input.currency.trim())) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace offer currency must be a three-letter code.", 400);
  if (input.commissionRateBps !== undefined && (!Number.isInteger(input.commissionRateBps) || input.commissionRateBps < 0 || input.commissionRateBps > 10000)) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace commission rate must be between 0 and 10000 basis points.", 400);
  if (input.commissionAmountCents !== undefined && (!Number.isInteger(input.commissionAmountCents) || input.commissionAmountCents < 0)) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace commission amount must be a non-negative integer.", 400);
  if (!["in_stock", "out_of_stock", "limited", "unknown"].includes(input.availability)) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace offer availability is invalid.", 400);
  if (input.affiliateLinkExpiresAt !== undefined && !Number.isFinite(Date.parse(input.affiliateLinkExpiresAt))) throw new DomainError("INVALID_MARKETPLACE_OFFER", "Marketplace affiliate link expiry must be a valid timestamp.", 400);
}
