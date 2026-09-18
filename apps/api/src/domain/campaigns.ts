import { randomUUID } from "node:crypto";
import type { Campaign, CreateCampaignRequest, CreateTrackingLinkRequest, RecordClickRequest, TrackingLink, TrackingLinkStats, UpdateCampaignRequest } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { AffiliateOfferRepository, CampaignOfferRepository, ClickRepository, Repository, TrackingLinkRepository } from "./repository.js";

const now = () => new Date().toISOString();
const code = () => randomUUID().replaceAll("-", "").slice(0, 12);

export class CampaignService {
  constructor(private readonly campaigns: Repository<Campaign>, private readonly campaignOffers: CampaignOfferRepository, private readonly affiliateOffers: AffiliateOfferRepository) {}
  list() { return this.campaigns.list(); }
  async get(id: string) { const campaign = await this.campaigns.findById(id); if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404); return campaign; }
  async create(input: CreateCampaignRequest) { const createdAt = now(); return this.campaigns.save({ id: randomUUID(), name: input.name, objective: input.objective, status: input.status ?? "draft", startAt: input.startAt, endAt: input.endAt, audience: input.audience ?? {}, createdAt, updatedAt: createdAt }); }
  async update(id: string, input: UpdateCampaignRequest) { const current = await this.get(id); return this.campaigns.save({ ...current, ...input, updatedAt: now() }); }
  async attachOffer(campaignId: string, affiliateOfferId: string) { await this.get(campaignId); if (!(await this.affiliateOffers.findById(affiliateOfferId))) throw new DomainError("AFFILIATE_OFFER_NOT_FOUND", "The affiliate offer does not exist.", 404); return (await this.campaignOffers.find(campaignId, affiliateOfferId)) ?? this.campaignOffers.save({ campaignId, affiliateOfferId, createdAt: now() }); }
  listOffers(campaignId: string) { return this.campaignOffers.listByCampaign(campaignId); }
  async removeOffer(campaignId: string, affiliateOfferId: string) { await this.get(campaignId); await this.campaignOffers.remove(campaignId, affiliateOfferId); }
}

export class TrackingService {
  constructor(private readonly links: TrackingLinkRepository, private readonly clicks: ClickRepository, private readonly campaigns: Repository<Campaign>, private readonly affiliateOffers: AffiliateOfferRepository, private readonly campaignOffers: CampaignOfferRepository) {}
  list(campaignId?: string) { return campaignId ? this.links.listByCampaign(campaignId) : this.links.list(); }
  async create(input: CreateTrackingLinkRequest) {
    const offer = await this.affiliateOffers.findById(input.affiliateOfferId);
    if (!offer) throw new DomainError("AFFILIATE_OFFER_NOT_FOUND", "The affiliate offer does not exist.", 404);
    if (offer.status !== "active") throw new DomainError("AFFILIATE_OFFER_NOT_ACTIVE", "Tracking links require an active affiliate offer.");
    if (input.campaignId) {
      if (!(await this.campaigns.findById(input.campaignId))) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404);
      if (!(await this.campaignOffers.find(input.campaignId, input.affiliateOfferId))) throw new DomainError("OFFER_NOT_ATTACHED", "The affiliate offer must be attached to the campaign first.");
    }
    const link: TrackingLink = { id: randomUUID(), affiliateOfferId: input.affiliateOfferId, campaignId: input.campaignId, code: input.code ?? code(), destinationUrl: input.destinationUrl, status: "active", createdAt: now(), updatedAt: now() };
    if (await this.links.findByCode(link.code)) throw new DomainError("TRACKING_CODE_EXISTS", "The tracking code is already in use.", 409);
    return this.links.save(link);
  }
  async get(id: string) { const link = await this.links.findById(id); if (!link) throw new DomainError("TRACKING_LINK_NOT_FOUND", "The tracking link does not exist.", 404); return link; }
  async recordClick(id: string, input: RecordClickRequest) { const link = await this.get(id); if (link.status !== "active") throw new DomainError("TRACKING_LINK_NOT_ACTIVE", "Clicks require an active tracking link."); return this.clicks.save({ id: randomUUID(), trackingLinkId: link.id, occurredAt: input.occurredAt ?? now(), metadata: input.metadata ?? {} }); }
  async stats(id: string): Promise<TrackingLinkStats> { await this.get(id); return { linkId: id, clickCount: (await this.clicks.listByTrackingLink(id)).length }; }
}
