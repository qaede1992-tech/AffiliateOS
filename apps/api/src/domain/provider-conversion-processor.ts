import type { Conversion } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { ConversionService } from "./services.js";
import type { NormalizedProviderConversion } from "./provider-conversion.js";

export interface ProviderConversionLifecycle {
  reconcileProviderState(conversionId: string, status: NormalizedProviderConversion["status"], commissionCents?: number): Promise<Conversion>;
}

export interface ProviderConversionTrackingResolution { affiliateId: string; offerId: string; affiliateOfferId: string; trackingLinkId: string; }
export interface ProviderConversionResolver {
  resolveAffiliate(reference: string): Promise<string | undefined>;
  resolveOffer(reference: string): Promise<string | undefined>;
  resolveTracking?(accountScope: string, reference: string): Promise<ProviderConversionTrackingResolution | undefined>;
}
export interface ProviderConversionAttributor {
  attribute(conversionId: string, trackingLinkId: string): Promise<void>;
}

export class ProviderConversionProcessor {
  constructor(
    private readonly conversions: ConversionService & ProviderConversionLifecycle,
    private readonly resolver: ProviderConversionResolver,
    private readonly attributor?: ProviderConversionAttributor
  ) {}

  async process(accountScope: string, event: NormalizedProviderConversion): Promise<Conversion> {
    if (!accountScope.trim()) throw new DomainError("PROVIDER_CONVERSION_ACCOUNT_MISSING", "Provider conversion account scope is required.", 422);
    if (!event.externalConversionId.trim()) throw new DomainError("PROVIDER_CONVERSION_ID_MISSING", "Provider conversion external ID is required.", 422);
    if (event.externalConversionId.length > 255) throw new DomainError("PROVIDER_CONVERSION_ID_INVALID", "Provider conversion external ID is too long.", 422);
    const affiliateReference = event.affiliateReference?.trim();
    const offerReference = event.offerReference?.trim();
    const trackingReference = event.trackingReference?.trim();
    let affiliateId: string | undefined;
    let offerId: string | undefined;
    let affiliateOfferId: string | undefined;
    let trackingLinkId: string | undefined;

    if (affiliateReference && offerReference) {
      if (affiliateReference.length > 255) throw new DomainError("PROVIDER_CONVERSION_AFFILIATE_INVALID", "Provider conversion affiliate reference is too long.", 422);
      if (offerReference.length > 255) throw new DomainError("PROVIDER_CONVERSION_OFFER_INVALID", "Provider conversion offer reference is too long.", 422);
      affiliateId = await this.resolver.resolveAffiliate(affiliateReference);
      offerId = await this.resolver.resolveOffer(offerReference);
      if (!affiliateId) throw new DomainError("PROVIDER_CONVERSION_AFFILIATE_UNKNOWN", "The provider affiliate reference could not be resolved.", 422);
      if (!offerId) throw new DomainError("PROVIDER_CONVERSION_OFFER_UNKNOWN", "The provider offer reference could not be resolved.", 422);
    } else if (trackingReference && this.resolver.resolveTracking) {
      if (trackingReference.length > 255) throw new DomainError("PROVIDER_CONVERSION_TRACKING_INVALID", "Provider conversion tracking reference is too long.", 422);
      const resolved = await this.resolver.resolveTracking(accountScope.trim(), trackingReference);
      if (!resolved) throw new DomainError("PROVIDER_CONVERSION_TRACKING_UNKNOWN", "The provider tracking reference could not be resolved.", 422);
      ({ affiliateId, offerId, affiliateOfferId, trackingLinkId } = resolved);
    } else {
      throw new DomainError("PROVIDER_CONVERSION_REFERENCE_MISSING", "Provider conversion requires affiliate/offer references or a resolvable tracking reference.", 422);
    }

    const normalizedScope = accountScope.trim();
    const conversion = await this.conversions.create({
      affiliateId,
      offerId,
      affiliateOfferId,
      amountCents: event.amountCents,
      occurredAt: event.occurredAt,
      idempotencyKey: `provider:${normalizedScope}:${event.externalConversionId}`
    });

    if (trackingLinkId && this.attributor) await this.attributor.attribute(conversion.id, trackingLinkId);

    if (event.status !== "pending" || event.commissionCents !== undefined) {
      return this.conversions.reconcileProviderState(conversion.id, event.status, event.commissionCents);
    }

    return conversion;
  }
}
