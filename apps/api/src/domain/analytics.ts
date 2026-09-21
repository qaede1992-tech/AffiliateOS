import type { Campaign, Commission, Content, Conversion, Click, TrackingLink } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { AnalyticsReader } from "./analytics-db.js";
import type { ConversionAttribution } from "@affiliateos/shared";
import type { Repository, TrackingLinkRepository } from "./repository.js";
import type { ConversionAttributionRepository } from "./attribution.js";

export interface CampaignAnalytics {
  campaignId: string;
  productId?: string;
  clickCount: number;
  trackingLinkCount: number;
  contentCount: number;
  publishedContentCount: number;
  scheduledContentCount: number;
  attributedConversionCount: number;
  attributedRevenueCents: number;
  attributedCommissionCents: number;
  conversionRate: number;
}

export interface AnalyticsOverview {
  clickCount: number;
  trackingLinkCount: number;
  campaignCount: number;
  contentCount: number;
  publishedContentCount: number;
  scheduledContentCount: number;
  attributedConversionCount: number;
  attributedRevenueCents: number;
  attributedCommissionCents: number;
  conversionRate: number;
  campaigns: CampaignAnalytics[];
}

export class AnalyticsService {
  constructor(
    private readonly campaigns: Repository<Campaign>,
    private readonly trackingLinks: TrackingLinkRepository,
    private readonly clicks: Repository<Click>,
    private readonly contents: Repository<Content>,
    private readonly reader?: AnalyticsReader,
    private readonly conversions?: Repository<Conversion>,
    private readonly commissions?: Repository<Commission>,
    private readonly attributions?: ConversionAttributionRepository
  ) {}

  async overview(): Promise<AnalyticsOverview> {
    if (this.reader) return this.reader.overview();
    const [campaigns, trackingLinks, clicks, contents, conversions, commissions, attributions] = await Promise.all([
      this.campaigns.list(), this.trackingLinks.list(), this.clicks.list(), this.contents.list(),
      this.conversions?.list() ?? Promise.resolve([]), this.commissions?.list() ?? Promise.resolve([]), this.attributions?.list() ?? Promise.resolve([])
    ]);
    return this.buildOverview(campaigns, trackingLinks, clicks, contents, conversions, commissions, attributions);
  }

  async campaign(campaignId: string): Promise<CampaignAnalytics> {
    if (this.reader) return this.reader.campaign(campaignId);
    const [campaigns, trackingLinks, clicks, contents, conversions, commissions, attributions] = await Promise.all([
      this.campaigns.list(), this.trackingLinks.listByCampaign(campaignId), this.clicks.list(), this.contents.list(),
      this.conversions?.list() ?? Promise.resolve([]), this.commissions?.list() ?? Promise.resolve([]), this.attributions?.list() ?? Promise.resolve([])
    ]);
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404);
    return this.buildCampaign(campaign, trackingLinks, clicks, contents.filter((item) => item.campaignId === campaignId), conversions, commissions, attributions);
  }

  private buildOverview(campaigns: Campaign[], trackingLinks: TrackingLink[], clicks: Click[], contents: Content[], conversions: Conversion[], commissions: Commission[], attributions: ConversionAttribution[]): AnalyticsOverview {
    const campaignStats = campaigns.map((campaign) => this.buildCampaign(
      campaign,
      trackingLinks.filter((link) => link.campaignId === campaign.id),
      clicks,
      contents.filter((item) => item.campaignId === campaign.id),
      conversions,
      commissions,
      attributions
    ));
    const attributed = this.attribute(clicks, trackingLinks, conversions, commissions, attributions);
    return {
      clickCount: clicks.length,
      trackingLinkCount: trackingLinks.length,
      campaignCount: campaigns.length,
      contentCount: contents.length,
      publishedContentCount: contents.filter((item) => item.status === "published").length,
      scheduledContentCount: contents.filter((item) => item.status === "scheduled").length,
      attributedConversionCount: attributed.count,
      attributedRevenueCents: attributed.revenueCents,
      attributedCommissionCents: attributed.commissionCents,
      conversionRate: rate(attributed.count, clicks.length),
      campaigns: campaignStats
    };
  }

  private buildCampaign(campaign: Campaign, trackingLinks: TrackingLink[], allClicks: Click[], contents: Content[], conversions: Conversion[], commissions: Commission[], attributions: ConversionAttribution[]): CampaignAnalytics {
    const attributed = this.attribute(allClicks, trackingLinks, conversions, commissions, attributions);
    const clickCount = allClicks.filter((click) => trackingLinks.some((link) => link.id === click.trackingLinkId)).length;
    const productId = typeof campaign.audience.productId === "string" ? campaign.audience.productId : undefined;
    return {
      campaignId: campaign.id,
      productId,
      clickCount,
      trackingLinkCount: trackingLinks.length,
      contentCount: contents.length,
      publishedContentCount: contents.filter((item) => item.status === "published").length,
      scheduledContentCount: contents.filter((item) => item.status === "scheduled").length,
      attributedConversionCount: attributed.count,
      attributedRevenueCents: attributed.revenueCents,
      attributedCommissionCents: attributed.commissionCents,
      conversionRate: rate(attributed.count, clickCount)
    };
  }

  private attribute(allClicks: Click[], links: TrackingLink[], conversions: Conversion[], commissions: Commission[], attributions: ConversionAttribution[]) {
    const linkIds = new Set(links.map((link) => link.id));
    const conversionIds = new Set(attributions.filter((item) => linkIds.has(item.trackingLinkId)).map((item) => item.conversionId));
    const validConversions = conversions.filter((item) => conversionIds.has(item.id) && item.status !== "rejected");
    const validConversionIds = new Set(validConversions.map((item) => item.id));
    return {
      count: validConversions.length,
      revenueCents: validConversions.reduce((sum, item) => sum + item.amountCents, 0),
      commissionCents: commissions.filter((item) => validConversionIds.has(item.conversionId)).reduce((sum, item) => sum + item.amountCents, 0)
    };
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
