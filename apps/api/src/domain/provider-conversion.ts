import type { ConversionStatus, IsoTimestamp, MoneyCents } from "@affiliateos/shared";

export type NormalizedProviderConversion = {
  externalConversionId: string;
  affiliateReference?: string;
  offerReference?: string;
  trackingReference?: string;
  orderReference?: string;
  amountCents: MoneyCents;
  currency?: string;
  commissionCents?: MoneyCents;
  occurredAt: IsoTimestamp;
  status: ConversionStatus;
  sourceEventId: string;
  rawEventType: string;
};

export interface ProviderConversionNormalizer {
  supports(eventType: string, payload: Record<string, unknown>): boolean;
  normalize(input: { eventId: string; eventType: string; payload: Record<string, unknown> }): NormalizedProviderConversion;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const integer = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const iso = (value: unknown): string | undefined => {
  const valueText = text(value);
  if (!valueText) return undefined;
  const timestamp = Date.parse(valueText);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

export class GenericProviderConversionNormalizer implements ProviderConversionNormalizer {
  supports(eventType: string, payload: Record<string, unknown>): boolean {
    return eventType.startsWith("conversion.") || text(payload.type)?.startsWith("conversion.") === true;
  }

  normalize(input: { eventId: string; eventType: string; payload: Record<string, unknown> }): NormalizedProviderConversion {
    const payload = input.payload;
    const eventType = text(input.eventType);
    if (!eventType || eventType.length > 255) throw new Error("Provider conversion event type is missing or invalid.");
    const payloadType = text(payload.type);
    if (!eventType.startsWith("conversion.") && !payloadType?.startsWith("conversion.")) throw new Error("Provider conversion event type is unsupported.");
    const eventId = text(input.eventId);
    if (!eventId || eventId.length > 255) throw new Error("Provider conversion source event ID is missing or invalid.");
    const externalConversionId = text(payload.conversion_id) ?? text(payload.conversionId) ?? text(payload.id);
    if (!externalConversionId || externalConversionId.length > 255) throw new Error("Provider conversion is missing a valid external conversion ID.");

    const amountCents = integer(payload.amount_cents) ?? integer(payload.amountCents) ?? this.moneyToCents(payload.amount, "amount");
    if (amountCents === undefined || amountCents < 0) throw new Error("Provider conversion is missing a valid non-negative amount.");
    if (amountCents > Number.MAX_SAFE_INTEGER) throw new Error("Provider conversion amount is outside the supported money range.");

    const occurredAt = iso(payload.occurred_at) ?? iso(payload.occurredAt) ?? iso(payload.created_at) ?? iso(payload.createdAt);
    if (!occurredAt) throw new Error("Provider conversion is missing a valid occurred-at timestamp.");

    const status = this.status(payload.status);
    if (status === "approved" && amountCents === 0 && commissionCents !== undefined && commissionCents > 0) throw new Error("Approved zero-value provider conversions cannot have a positive commission.");
    const hasExplicitStatus = text(payload.status) !== undefined;
    if (hasExplicitStatus && !["approved", "rejected", "cancelled", "canceled", "pending"].includes(text(payload.status)!.toLowerCase())) {
      throw new Error("Provider conversion status is invalid.");
    }
    if (status === "rejected" && (payload.commission_cents !== undefined || payload.commissionCents !== undefined || payload.commission !== undefined)) {
      throw new Error("Rejected provider conversions cannot include a commission amount.");
    }
    const commissionCents = integer(payload.commission_cents) ?? integer(payload.commissionCents) ?? (payload.commission !== undefined ? this.moneyToCents(payload.commission, "commission") : undefined);
    if (commissionCents !== undefined && commissionCents < 0) throw new Error("Provider conversion commission must be non-negative.");
    if (commissionCents !== undefined && commissionCents > Number.MAX_SAFE_INTEGER) throw new Error("Provider conversion commission is outside the supported money range.");
    if (commissionCents !== undefined && commissionCents > amountCents) throw new Error("Provider conversion commission cannot exceed conversion amount.");

    const currency = text(payload.currency)?.toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error("Provider conversion currency must be a three-letter ISO code.");
    if (currency && currency === "XXX") throw new Error("Provider conversion currency cannot be the no-currency code.");

    return {
      externalConversionId,
      affiliateReference: text(payload.affiliate_reference) ?? text(payload.affiliateReference) ?? text(payload.affiliate_id) ?? text(payload.affiliateId),
      offerReference: text(payload.offer_reference) ?? text(payload.offerReference) ?? text(payload.offer_id) ?? text(payload.offerId),
      trackingReference: text(payload.tracking_reference) ?? text(payload.trackingReference) ?? text(payload.tracking_link) ?? text(payload.trackingLink),
      orderReference: text(payload.order_reference) ?? text(payload.orderReference) ?? text(payload.order_id) ?? text(payload.orderId),
      amountCents,
      currency,
      commissionCents,
      occurredAt,
      status,
      sourceEventId: eventId,
      rawEventType: eventType
    };
  }

  private moneyToCents(value: unknown, field: string): number {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(Math.round(numeric * 100))) throw new Error(`Provider conversion ${field} must be a valid non-negative monetary value.`);
    const cents = Math.round(numeric * 100);
    if (!Number.isSafeInteger(cents)) throw new Error(`Provider conversion ${field} is outside the supported money range.`);
    return cents;
  }

  private status(value: unknown): ConversionStatus {
    switch (text(value)?.toLowerCase()) {
      case "approved": return "approved";
      case "rejected": case "cancelled": case "canceled": return "rejected";
      default: return "pending";
    }
  }
}
