import type { Campaign, Content, Click, TrackingLink } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { Repository, TrackingLinkRepository } from "./repository.js";

export interface CampaignAnalytics {
  campaignId: string;
  clickCount: number;
  trackingLinkCount: number;
  contentCount: number;
  publishedContentCount: number;
  scheduledContentCount: number;
}

export interface AnalyticsOverview {
  clickCount: number;
  trackingLinkCount: number;
  campaignCount: number;
  contentCount: number;
  publishedContentCount: number;
  scheduledContentCount: number;
  campaigns: CampaignAnalytics[];
}

export class AnalyticsService {
  constructor(
    private readonly campaigns: Repository<Campaign>,
    private readonly trackingLinks: TrackingLinkRepository,
    private readonly clicks: Repository<Click>,
    private readonly contents: Repository<Content>
  ) {}

  async overview(): Promise<AnalyticsOverview> {
    const [campaigns, trackingLinks, clicks, contents] = await Promise.all([
      this.campaigns.list(), this.trackingLinks.list(), this.clicks.list(), this.contents.list()
    ]);
    return this.buildOverview(campaigns, trackingLinks, clicks, contents);
  }

  async campaign(campaignId: string): Promise<CampaignAnalytics> {
    const [campaigns, trackingLinks, clicks, contents] = await Promise.all([
      this.campaigns.list(), this.trackingLinks.listByCampaign(campaignId), this.clicks.list(), this.contents.list()
    ]);
    if (!campaigns.some((item) => item.id === campaignId)) {
      throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404);
    }
    return this.buildCampaign(campaignId, trackingLinks, clicks, contents.filter((item) => item.campaignId === campaignId));
  }

  private buildOverview(campaigns: Campaign[], trackingLinks: TrackingLink[], clicks: Click[], contents: Content[]): AnalyticsOverview {
    const campaignStats = campaigns.map((campaign) => this.buildCampaign(
      campaign.id,
      trackingLinks.filter((link) => link.campaignId === campaign.id),
      clicks,
      contents.filter((item) => item.campaignId === campaign.id)
    ));
    return {
      clickCount: clicks.length,
      trackingLinkCount: trackingLinks.length,
      campaignCount: campaigns.length,
      contentCount: contents.length,
      publishedContentCount: contents.filter((item) => item.status === "published").length,
      scheduledContentCount: contents.filter((item) => item.status === "scheduled").length,
      campaigns: campaignStats
    };
  }

  private buildCampaign(campaignId: string, trackingLinks: TrackingLink[], allClicks: Click[], contents: Content[]): CampaignAnalytics {
    const linkIds = new Set(trackingLinks.map((link) => link.id));
    return {
      campaignId,
      clickCount: allClicks.filter((click) => linkIds.has(click.trackingLinkId)).length,
      trackingLinkCount: trackingLinks.length,
      contentCount: contents.length,
      publishedContentCount: contents.filter((item) => item.status === "published").length,
      scheduledContentCount: contents.filter((item) => item.status === "scheduled").length
    };
  }
}
