import type { Conversion } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { ConversionService } from "./services.js";
import type { NormalizedProviderConversion } from "./provider-conversion.js";

export interface ProviderConversionLifecycle {
  reconcileProviderState(conversionId: string, status: NormalizedProviderConversion["status"], commissionCents?: number): Promise<Conversion>;
}

export interface ProviderConversionResolver {
  resolveAffiliate(reference: string): Promise<string | undefined>;
  resolveOffer(reference: string): Promise<string | undefined>;
}

export class ProviderConversionProcessor {
  constructor(
    private readonly conversions: ConversionService & ProviderConversionLifecycle,
    private readonly resolver: ProviderConversionResolver
  ) {}

  async process(accountScope: string, event: NormalizedProviderConversion): Promise<Conversion> {
    if (!accountScope.trim()) throw new DomainError("PROVIDER_CONVERSION_ACCOUNT_MISSING", "Provider conversion account scope is required.", 422);
    if (!event.externalConversionId.trim()) throw new DomainError("PROVIDER_CONVERSION_ID_MISSING", "Provider conversion external ID is required.", 422);
    if (event.externalConversionId.length > 255) throw new DomainError("PROVIDER_CONVERSION_ID_INVALID", "Provider conversion external ID is too long.", 422);
    if (!event.affiliateReference) throw new DomainError("PROVIDER_CONVERSION_AFFILIATE_MISSING", "Provider conversion is missing an affiliate reference.", 422);
    if (!event.offerReference) throw new DomainError("PROVIDER_CONVERSION_OFFER_MISSING", "Provider conversion is missing an offer reference.", 422);

    const affiliateId = await this.resolver.resolveAffiliate(event.affiliateReference);
    if (!affiliateId) throw new DomainError("PROVIDER_CONVERSION_AFFILIATE_UNKNOWN", "The provider affiliate reference could not be resolved.", 422);
    const offerId = await this.resolver.resolveOffer(event.offerReference);
    if (!offerId) throw new DomainError("PROVIDER_CONVERSION_OFFER_UNKNOWN", "The provider offer reference could not be resolved.", 422);

    const normalizedScope = accountScope.trim();
    const conversion = await this.conversions.create({
      affiliateId,
      offerId,
      amountCents: event.amountCents,
      occurredAt: event.occurredAt,
      idempotencyKey: `provider:${normalizedScope}:${event.externalConversionId}`
    });

    if (event.status !== "pending" || event.commissionCents !== undefined) {
      return this.conversions.reconcileProviderState(conversion.id, event.status, event.commissionCents);
    }

    return conversion;
  }
}
