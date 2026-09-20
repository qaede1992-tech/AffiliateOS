import type { Conversion } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { ProviderConversionNormalizer } from "./provider-conversion.js";
import type { ProviderConversionProcessor } from "./provider-conversion-processor.js";
import type { ProviderEventProcessor } from "./provider-event-processor.js";

export interface ProviderEventConversionNormalizerRegistry {
  resolve(eventType: string, payload: Record<string, unknown>): ProviderConversionNormalizer | undefined;
}

export class StaticProviderEventConversionNormalizerRegistry implements ProviderEventConversionNormalizerRegistry {
  constructor(private readonly normalizers: readonly ProviderConversionNormalizer[]) {}

  resolve(eventType: string, payload: Record<string, unknown>): ProviderConversionNormalizer | undefined {
    return this.normalizers.find((normalizer) => normalizer.supports(eventType, payload));
  }
}

export class ProviderEventConversionProcessor {
  constructor(
    private readonly events: ProviderEventProcessor,
    private readonly normalizers: ProviderEventConversionNormalizerRegistry,
    private readonly conversions: ProviderConversionProcessor
  ) {}

  async process(affiliateAccountId: string, externalEventId: string): Promise<{ processed: boolean; conversion?: Conversion }> {
    if (!affiliateAccountId.trim()) throw new DomainError("PROVIDER_EVENT_ACCOUNT_MISSING", "Provider event account scope is required.", 422);
    if (!externalEventId.trim()) throw new DomainError("PROVIDER_EVENT_ID_MISSING", "Provider event ID is required.", 422);

    return this.events.process(affiliateAccountId, externalEventId, async (event) => {
      const normalizer = this.normalizers.resolve(event.eventType, event.payload);
      if (!normalizer) {
        throw new DomainError("PROVIDER_EVENT_UNSUPPORTED", "The provider event type is not supported for conversion processing.", 422);
      }

      const normalized = normalizer.normalize({
        eventId: event.externalEventId,
        eventType: event.eventType,
        payload: event.payload
      });

      return this.conversions.process(affiliateAccountId, normalized);
    }).then((result) => ({
      processed: result.processed,
      conversion: result.result
    }));
  }
}
