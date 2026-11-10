import type { EntityId } from "@affiliateos/shared";
import { sql } from "drizzle-orm";
import type { AnalyticsReader } from "../domain/analytics-db.js";
import type { CampaignAnalytics, AnalyticsOverview } from "../domain/analytics.js";
import { DomainError } from "../domain/errors.js";

const campaignAnalyticsSql = sql`WITH link_stats AS (
  SELECT campaign_id, COUNT(*) AS tracking_link_count
  FROM tracking_links
  GROUP BY campaign_id
), click_stats AS (
  SELECT tl.campaign_id, COUNT(cl.id) AS click_count
  FROM tracking_links tl
  LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
  GROUP BY tl.campaign_id
), content_stats AS (
  SELECT campaign_id,
    COUNT(*) AS content_count,
    COUNT(*) FILTER (WHERE status = 'published') AS published_content_count,
    COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_content_count
  FROM content
  GROUP BY campaign_id
), attribution_stats AS (
  SELECT atl.campaign_id,
    COUNT(*) FILTER (WHERE cv.status = 'approved') AS attributed_conversion_count,
    COALESCE(SUM(cv.amount_cents) FILTER (WHERE cv.status = 'approved'), 0) AS attributed_revenue_cents,
    COALESCE(SUM(cm.amount_cents) FILTER (
      WHERE cv.status = 'approved' AND cm.status IN ('approved', 'paid')
    ), 0) AS attributed_commission_cents
  FROM conversion_attributions ca
  JOIN conversions cv ON cv.id = ca.conversion_id
  JOIN tracking_links atl ON atl.id = ca.tracking_link_id
  LEFT JOIN commissions cm ON cm.conversion_id = cv.id
  GROUP BY atl.campaign_id
)
SELECT c.id AS campaign_id,
  c.audience ->> 'productId' AS product_id,
  p.marketplace_id AS marketplace_id,
  p.category AS category,
  c.audience -> 'audience' AS audience_segments,
  COALESCE(ls.tracking_link_count, 0) AS tracking_link_count,
  COALESCE(cs.click_count, 0) AS click_count,
  COALESCE(ct.content_count, 0) AS content_count,
  COALESCE(ct.published_content_count, 0) AS published_content_count,
  COALESCE(ct.scheduled_content_count, 0) AS scheduled_content_count,
  COALESCE(ast.attributed_conversion_count, 0) AS attributed_conversion_count,
  COALESCE(ast.attributed_revenue_cents, 0) AS attributed_revenue_cents,
  COALESCE(ast.attributed_commission_cents, 0) AS attributed_commission_cents
FROM campaigns c
LEFT JOIN products p ON p.id = CASE
  WHEN c.audience ->> 'productId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN (c.audience ->> 'productId')::uuid
END
LEFT JOIN link_stats ls ON ls.campaign_id = c.id
LEFT JOIN click_stats cs ON cs.campaign_id = c.id
LEFT JOIN content_stats ct ON ct.campaign_id = c.id
LEFT JOIN attribution_stats ast ON ast.campaign_id = c.id`;

export class DrizzleAnalyticsReader implements AnalyticsReader {
  constructor(private readonly db: any) {}

  async overview(): Promise<AnalyticsOverview> {
    const [totalResult, campaignResult] = await Promise.all([
      this.db.execute(sql`SELECT
        (SELECT COUNT(*) FROM clicks) AS click_count,
        (SELECT COUNT(*) FROM tracking_links) AS tracking_link_count,
        (SELECT COUNT(*) FROM campaigns) AS campaign_count,
        (SELECT COUNT(*) FROM content) AS content_count,
        (SELECT COUNT(*) FROM content WHERE status = 'published') AS published_content_count,
        (SELECT COUNT(*) FROM content WHERE status = 'scheduled') AS scheduled_content_count,
        (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id WHERE cv.status = 'approved') AS attributed_conversion_count,
        (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id WHERE cv.status = 'approved') AS attributed_revenue_cents,
        (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id WHERE cv.status = 'approved' AND cm.status IN ('approved', 'paid')) AS attributed_commission_cents`),
      this.db.execute(sql`${campaignAnalyticsSql} ORDER BY c.created_at ASC, c.id ASC`)
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
    const result = await this.db.execute(sql`WITH campaign_scope AS (
      SELECT id, audience, created_at FROM campaigns WHERE id = ${campaignId}
    ), link_stats AS (
      SELECT tl.campaign_id, COUNT(*) AS tracking_link_count
      FROM tracking_links tl JOIN campaign_scope c ON c.id = tl.campaign_id
      GROUP BY tl.campaign_id
    ), click_stats AS (
      SELECT tl.campaign_id, COUNT(cl.id) AS click_count
      FROM tracking_links tl
      JOIN campaign_scope c ON c.id = tl.campaign_id
      LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
      GROUP BY tl.campaign_id
    ), content_stats AS (
      SELECT ct.campaign_id,
        COUNT(*) AS content_count,
        COUNT(*) FILTER (WHERE ct.status = 'published') AS published_content_count,
        COUNT(*) FILTER (WHERE ct.status = 'scheduled') AS scheduled_content_count
      FROM content ct JOIN campaign_scope c ON c.id = ct.campaign_id
      GROUP BY ct.campaign_id
    ), attribution_stats AS (
      SELECT atl.campaign_id,
        COUNT(*) FILTER (WHERE cv.status = 'approved') AS attributed_conversion_count,
        COALESCE(SUM(cv.amount_cents) FILTER (WHERE cv.status = 'approved'), 0) AS attributed_revenue_cents,
        COALESCE(SUM(cm.amount_cents) FILTER (
          WHERE cv.status = 'approved' AND cm.status IN ('approved', 'paid')
        ), 0) AS attributed_commission_cents
      FROM conversion_attributions ca
      JOIN conversions cv ON cv.id = ca.conversion_id
      JOIN tracking_links atl ON atl.id = ca.tracking_link_id
      JOIN campaign_scope c ON c.id = atl.campaign_id
      LEFT JOIN commissions cm ON cm.conversion_id = cv.id
      GROUP BY atl.campaign_id
    )
    SELECT c.id AS campaign_id,
      c.audience ->> 'productId' AS product_id,
      p.marketplace_id AS marketplace_id,
      p.category AS category,
      c.audience -> 'audience' AS audience_segments,
      COALESCE(ls.tracking_link_count, 0) AS tracking_link_count,
      COALESCE(cs.click_count, 0) AS click_count,
      COALESCE(ct.content_count, 0) AS content_count,
      COALESCE(ct.published_content_count, 0) AS published_content_count,
      COALESCE(ct.scheduled_content_count, 0) AS scheduled_content_count,
      COALESCE(ast.attributed_conversion_count, 0) AS attributed_conversion_count,
      COALESCE(ast.attributed_revenue_cents, 0) AS attributed_revenue_cents,
      COALESCE(ast.attributed_commission_cents, 0) AS attributed_commission_cents
    FROM campaign_scope c
    LEFT JOIN products p ON p.id = CASE
      WHEN c.audience ->> 'productId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (c.audience ->> 'productId')::uuid
    END
    LEFT JOIN link_stats ls ON ls.campaign_id = c.id
    LEFT JOIN click_stats cs ON cs.campaign_id = c.id
    LEFT JOIN content_stats ct ON ct.campaign_id = c.id
    LEFT JOIN attribution_stats ast ON ast.campaign_id = c.id`);

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

function numberValue(value: unknown): number { return Number(value ?? 0); }
function rate(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator; }

function toCampaignAnalytics(row: Record<string, unknown>): CampaignAnalytics {
  const clickCount = numberValue(row.click_count);
  const attributedConversionCount = numberValue(row.attributed_conversion_count);
  return {
    campaignId: String(row.campaign_id),
    productId: typeof row.product_id === "string" ? row.product_id : undefined,
    marketplaceId: typeof row.marketplace_id === "string" ? row.marketplace_id : undefined,
    category: typeof row.category === "string" ? row.category : undefined,
    audienceSegments: Array.isArray(row.audience_segments)
      ? row.audience_segments.filter((item): item is string => typeof item === "string")
      : undefined,
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
