import type { EntityId } from "@affiliateos/shared";
import { sql } from "drizzle-orm";
import type { AnalyticsReader } from "../domain/analytics-db.js";
import type { CampaignAnalytics, AnalyticsOverview } from "../domain/analytics.js";

export class DrizzleAnalyticsReader implements AnalyticsReader {
  constructor(private readonly db: any) {}

  async overview(): Promise<AnalyticsOverview> {
    const [totals, campaigns] = await Promise.all([
      this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM clicks) AS click_count,
          (SELECT COUNT(*) FROM tracking_links) AS tracking_link_count,
          (SELECT COUNT(*) FROM campaigns) AS campaign_count,
          (SELECT COUNT(*) FROM content) AS content_count,
          (SELECT COUNT(*) FROM content WHERE status = 'published') AS published_content_count,
          (SELECT COUNT(*) FROM content WHERE status = 'scheduled') AS scheduled_content_count
      `),
      this.db.execute(sql`
        SELECT
          c.id AS campaign_id,
          COUNT(DISTINCT tl.id) AS tracking_link_count,
          COUNT(DISTINCT cl.id) AS click_count,
          COUNT(DISTINCT ct.id) AS content_count,
          COUNT(DISTINCT CASE WHEN ct.status = 'published' THEN ct.id END) AS published_content_count,
          COUNT(DISTINCT CASE WHEN ct.status = 'scheduled' THEN ct.id END) AS scheduled_content_count
        FROM campaigns c
        LEFT JOIN tracking_links tl ON tl.campaign_id = c.id
        LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
        LEFT JOIN content ct ON ct.campaign_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at ASC, c.id ASC
      `)
    ]);

    const total = totals[0] as Record<string, unknown> | undefined;
    return {
      clickCount: numberValue(total?.click_count),
      trackingLinkCount: numberValue(total?.tracking_link_count),
      campaignCount: numberValue(total?.campaign_count),
      contentCount: numberValue(total?.content_count),
      publishedContentCount: numberValue(total?.published_content_count),
      scheduledContentCount: numberValue(total?.scheduled_content_count),
      campaigns: campaigns.map(toCampaignAnalytics)
    };
  }

  async campaign(campaignId: EntityId): Promise<CampaignAnalytics> {
    const rows = await this.db.execute(sql`
      SELECT
        c.id AS campaign_id,
        COUNT(DISTINCT tl.id) AS tracking_link_count,
        COUNT(DISTINCT cl.id) AS click_count,
        COUNT(DISTINCT ct.id) AS content_count,
        COUNT(DISTINCT CASE WHEN ct.status = 'published' THEN ct.id END) AS published_content_count,
        COUNT(DISTINCT CASE WHEN ct.status = 'scheduled' THEN ct.id END) AS scheduled_content_count
      FROM campaigns c
      LEFT JOIN tracking_links tl ON tl.campaign_id = c.id
      LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
      LEFT JOIN content ct ON ct.campaign_id = c.id
      WHERE c.id = ${campaignId}
      GROUP BY c.id
    `);
    if (!rows[0]) throw new Error("CAMPAIGN_NOT_FOUND");
    return toCampaignAnalytics(rows[0] as Record<string, unknown>);
  }
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function toCampaignAnalytics(row: Record<string, unknown>): CampaignAnalytics {
  return {
    campaignId: String(row.campaign_id),
    clickCount: numberValue(row.click_count),
    trackingLinkCount: numberValue(row.tracking_link_count),
    contentCount: numberValue(row.content_count),
    publishedContentCount: numberValue(row.published_content_count),
    scheduledContentCount: numberValue(row.scheduled_content_count)
  };
}
