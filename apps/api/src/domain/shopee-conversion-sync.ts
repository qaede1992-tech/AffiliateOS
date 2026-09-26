import type { Conversion } from "@affiliateos/shared";
import type { MarketplaceProvider } from "./foundations.js";
import type { ConversionService } from "./services.js";
import type { MarketplaceService } from "./marketplace.js";
import type { ProviderConversionProcessor } from "./provider-conversion-processor.js";
import type { ShopeeAffiliateConversionReportItem, ShopeeAffiliateProvider } from "./shopee-affiliate-provider.js";

export type MarketplaceConversionSyncResult = {
  fetched: number;
  created: number;
  alreadyProcessed: number;
  skippedUnattributed: number;
  failed: number;
};

export class ShopeeConversionSyncService {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly conversions: ConversionService,
    private readonly processor: ProviderConversionProcessor
  ) {}

  async sync(connectionSlug: string, since: string): Promise<MarketplaceConversionSyncResult> {
    const { account, provider } = await this.marketplace.getProviderForSync(connectionSlug);
    if (provider.slug !== "shopee-affiliate" || !("conversionReportDetailed" in provider)) {
      throw new Error("Marketplace connection does not expose the Shopee detailed conversion report.");
    }
    const reports = await (provider as ShopeeAffiliateProvider).conversionReportDetailed(since);
    const result: MarketplaceConversionSyncResult = { fetched: reports.length, created: 0, alreadyProcessed: 0, skippedUnattributed: 0, failed: 0 };
    for (const report of reports) {
      try {
        const amountCents = grossAmountCents(report);
        const commissionCents = report.netCommissionCents ?? report.totalCommissionCents;
        const conversion = await this.processor.process(account.id, {
          externalConversionId: report.conversionId,
          trackingReference: report.utmContent,
          amountCents,
          commissionCents,
          occurredAt: report.purchaseTime,
          status: reportStatus(report),
          sourceEventId: report.conversionId,
          rawEventType: "shopee.conversion.report"
        });
        await this.conversions.reconcileProviderState(conversion.id, reportStatus(report), commissionCents);
        result.created += 1;
      } catch (error) {
        if (isAlreadyProcessed(error)) result.alreadyProcessed += 1;
        else if (isUnattributed(error)) result.skippedUnattributed += 1;
        else result.failed += 1;
      }
    }
    return result;
  }
}

function grossAmountCents(report: ShopeeAffiliateConversionReportItem): number {
  let total = 0;
  for (const order of report.orders) for (const item of order.items) {
    const amount = item.actualAmountCents ?? item.itemPriceCents;
    if (amount !== undefined) total += Math.max(0, amount) * Math.max(1, item.qty ?? 1);
  }
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

function reportStatus(report: ShopeeAffiliateConversionReportItem): "approved" | "pending" | "rejected" {
  const status = report.orders.some(order => /cancel|refund|reject/i.test(order.orderStatus ?? "")) ? "rejected" : "approved";
  return status;
}

function isAlreadyProcessed(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as {code?: unknown}).code === "IDEMPOTENCY_KEY_CONFLICT");
}
function isUnattributed(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String((error as {code?: unknown}).code).includes("TRACKING"));
}
