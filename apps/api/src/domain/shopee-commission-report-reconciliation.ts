import { createHash } from "node:crypto";
import type { ConversionStatus, IsoTimestamp, MoneyCents } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { MarketplaceService } from "./marketplace.js";
import type { ProviderConversionProcessor } from "./provider-conversion-processor.js";

export type ShopeeCommissionReportRow = {
  rowKey: string;
  trackingReference: string;
  amountCents: MoneyCents;
  commissionCents?: MoneyCents;
  occurredAt: IsoTimestamp;
  status?: ConversionStatus;
  externalConversionId?: string;
};

export type ShopeeCommissionReportInput = {
  sourceReference: string;
  rows: ShopeeCommissionReportRow[];
};

export type ShopeeCommissionReportResult = {
  sourceReference: string;
  processed: number;
  failed: number;
  failures: Array<{ rowKey: string; error: string }>;
};

export class ShopeeCommissionReportReconciliationService {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly providerConversions: ProviderConversionProcessor
  ) {}

  async reconcile(connectionSlug: string, input: ShopeeCommissionReportInput): Promise<ShopeeCommissionReportResult> {
    const account = await this.marketplace.getAffiliateAccount(connectionSlug);
    if (!account.affiliateId) {
      throw new DomainError("AFFILIATE_ACCOUNT_UNBOUND", "The Shopee affiliate account must be bound to an Affiliate before report reconciliation.", 409);
    }

    let processed = 0;
    const failures: Array<{ rowKey: string; error: string }> = [];

    for (const row of input.rows) {
      try {
        const externalConversionId = row.externalConversionId?.trim() || `report:${createHash("sha256").update(input.sourceReference + "\\0" + row.rowKey).digest("hex")}`;
        await this.providerConversions.process(account.id, {
          externalConversionId,
          trackingReference: row.trackingReference,
          amountCents: row.amountCents,
          commissionCents: row.commissionCents,
          occurredAt: row.occurredAt,
          status: row.status ?? "approved",
          sourceEventId: input.sourceReference,
          rawEventType: "shopee.report.commission"
        });
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ rowKey: row.rowKey, error: message });
      }
    }

    return { sourceReference: input.sourceReference, processed, failed: failures.length, failures };
  }
}
