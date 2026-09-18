import type { EntityId } from "@affiliateos/shared";
import { sql } from "drizzle-orm";
import type { AnalyticsReader } from "../domain/analytics-db.js";
import type { CampaignAnalytics, AnalyticsOverview } from "../domain/analytics.js";
import { DomainError } from "../domain/errors.js";

export class DrizzleAnalyticsReader implements AnalyticsReader {
  constructor(private readonly db: any) {}

  async overview(): Promise<AnalyticsOverview> {
    const [totalResult, campaignResult] = await Promise.all([
      this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM clicks) AS click_count,
          (SELECT COUNT(*) FROM tracking_links) AS tracking_link_count,
          (SELECT COUNT(*) FROM campaigns) AS campaign_count,
          (SELECT COUNT(*) FROM content) AS content_count,
          (SELECT COUNT(*) FROM content WHERE status = 'published') AS published_content_count,
          (SELECT COUNT(*) FROM content WHERE status = 'scheduled') AS scheduled_content_count,
          (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id WHERE cv.status <> 'rejected') AS attributed_conversion_count,
          (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id WHERE cv.status <> 'rejected') AS attributed_revenue_cents,
          (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id WHERE cv.status <> 'rejected') AS attributed_commission_cents
      `),
      this.db.execute(sql`
        SELECT
          c.id AS campaign_id,
          COUNT(DISTINCT tl.id) AS tracking_link_count,
          COUNT(DISTINCT cl.id) AS click_count,
          COUNT(DISTINCT ct.id) AS content_count,
          COUNT(DISTINCT CASE WHEN ct.status = 'published' THEN ct.id END) AS published_content_count,
          COUNT(DISTINCT CASE WHEN ct.status = 'scheduled' THEN ct.id END) AS scheduled_content_count,
          (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_conversion_count,
          (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_revenue_cents,
          (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_commission_cents
        FROM campaigns c
        LEFT JOIN tracking_links tl ON tl.campaign_id = c.id
        LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
        LEFT JOIN content ct ON ct.campaign_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at ASC, c.id ASC
      `)
    ]);

    const total = rowsOf(totalResult)[0];
    const clickCount = numberValue(total?.click_count);
    const attributedConversionCount = numberValue(total?.attributed_conversion_count);
    return {
      clickCount,
      trackingLinkCount: numberValue(total?.tracking_link_count),
      campaignCount: numberValue(total?.campaign_count),
      contentCount: numberValue(total?.content_count),
      publishedContentCount: numberValue(total?.published_content_count),
      scheduledContentCount: numberValue(total?.scheduled_content_count),
      attributedConversionCount,
      attributedRevenueCents: numberValue(total?.attributed_revenue_cents),
      attributedCommissionCents: numberValue(total?.attributed_commission_cents),
      conversionRate: rate(attributedConversionCount, clickCount),
      campaigns: rowsOf(campaignResult).map(toCampaignAnalytics)
    };
  }

  async campaign(campaignId: EntityId): Promise<CampaignAnalytics> {
    const result = await this.db.execute(sql`
      SELECT
        c.id AS campaign_id,
        COUNT(DISTINCT tl.id) AS tracking_link_count,
        COUNT(DISTINCT cl.id) AS click_count,
        COUNT(DISTINCT ct.id) AS content_count,
        COUNT(DISTINCT CASE WHEN ct.status = 'published' THEN ct.id END) AS published_content_count,
        COUNT(DISTINCT CASE WHEN ct.status = 'scheduled' THEN ct.id END) AS scheduled_content_count,
        (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_conversion_count,
        (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_revenue_cents,
        (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id JOIN tracking_links atl ON atl.id = ca.tracking_link_id WHERE atl.campaign_id = c.id AND cv.status <> 'rejected') AS attributed_commission_cents
      FROM campaigns c
      LEFT JOIN tracking_links tl ON tl.campaign_id = c.id
      LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
      LEFT JOIN content ct ON ct.campaign_id = c.id
      WHERE c.id = ${campaignId}
      GROUP BY c.id
    `);
    const row = rowsOf(result)[0];
    if (!row) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404);
    return toCampaignAnalytics(row);
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function toCampaignAnalytics(row: Record<string, unknown>): CampaignAnalytics {
  const clickCount = numberValue(row.click_count);
  const attributedConversionCount = numberValue(row.attributed_conversion_count);
  return {
    campaignId: String(row.campaign_id),
    clickCount,
    trackingLinkCount: numberValue(row.tracking_link_count),
    contentCount: numberValue(row.content_count),
    publishedContentCount: numberValue(row.published_content_count),
    scheduledContentCount: numberValue(row.scheduled_content_count),
    attributedConversionCount,
    attributedRevenueCents: numberValue(row.attributed_revenue_cents),
    attributedCommissionCents: numberValue(row.attributed_commission_cents),
    conversionRate: rate(attributedConversionCount, clickCount)
  };
}
