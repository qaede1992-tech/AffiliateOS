import type { EntityId } from "@affiliateos/shared";
import type { CampaignAnalytics, AnalyticsOverview } from "./analytics.js";

export interface AnalyticsReader {
  overview(): Promise<AnalyticsOverview>;
  campaign(campaignId: EntityId): Promise<CampaignAnalytics>;
}
