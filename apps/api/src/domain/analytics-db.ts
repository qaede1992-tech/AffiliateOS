import type { EntityId } from "@affiliateos/shared";
import type { CampaignAnalytics, AnalyticsOverview } from "./analytics.js";

/** Production analytics reads are isolated from the domain repositories so they can use SQL aggregation. */
export interface AnalyticsReader {
  overview(): Promise<AnalyticsOverview>;
  campaign(campaignId: EntityId): Promise<CampaignAnalytics>;
}
