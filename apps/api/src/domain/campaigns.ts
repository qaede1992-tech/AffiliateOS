import { randomUUID } from "node:crypto";
import type { Campaign, CreateCampaignRequest, CreateTrackingLinkRequest, RecordClickRequest, TrackingLink, TrackingLinkStats, UpdateCampaignRequest } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { AffiliateOfferRepository, CampaignOfferRepository, ClickRepository, Repository, TrackingLinkRepository } from "./repository.js";

const now = () => new Date().toISOString();
const code = () => randomUUID().replaceAll("-", "").slice(0, 12);

const allowedTransitions: Record<Campaign["status"], Campaign["status"][]> = {
  draft: ["draft", "scheduled", "active", "archived"],
  scheduled: ["scheduled", "active", "paused", "archived"],
  active: ["active", "paused", "completed"],
  paused: ["paused", "active", "completed", "archived"],
  completed: ["completed", "archived"],
  archived: ["archived"]
};

function validateCampaignDates(startAt: string | undefined, endAt: string | undefined) {
  if (startAt && endAt && startAt > endAt) {
    throw new DomainError("INVALID_CAMPAIGN_DATES", "startAt must be before endAt.");
  }
}

function validateCampaignStatus(current: Campaign["status"], next: Campaign["status"] | undefined) {
  if (next && !allowedTransitions[current].includes(next)) {
    throw new DomainError("INVALID_CAMPAIGN_TRANSITION", `Campaign cannot transition from ${current} to ${next}.`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export class CampaignService {
  constructor(private readonly campaigns: Repository<Campaign>, private readonly campaignOffers: CampaignOfferRepository, private readonly affiliateOffers: AffiliateOfferRepository) {}
  list() { return this.campaigns.list(); }
  async get(id: string) { const campaign = await this.campaigns.findById(id); if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404); return campaign; }
  async create(input: CreateCampaignRequest) {
    validateCampaignDates(input.startAt, input.endAt);
    const createdAt = now();
    return this.campaigns.save({ id: randomUUID(), name: input.name, objective: input.objective, status: input.status ?? "draft", startAt: input.startAt, endAt: input.endAt, audience: input.audience ?? {}, createdAt, updatedAt: createdAt });
  }
  async update(id: string, input: UpdateCampaignRequest) {
    const current = await this.get(id);
    validateCampaignDates(input.startAt ?? current.startAt, input.endAt ?? current.endAt);
    validateCampaignStatus(current.status, input.status);
    return this.campaigns.save({ ...current, ...input, updatedAt: now() });
  }
  async attachOffer(campaignId: string, affiliateOfferId: string) { await this.get(campaignId); if (!(await this.affiliateOffers.findById(affiliateOfferId))) throw new DomainError("AFFILIATE_OFFER_NOT_FOUND", "The affiliate offer does not exist.", 404); return (await this.campaignOffers.find(campaignId, affiliateOfferId)) ?? this.campaignOffers.save({ campaignId, affiliateOfferId, createdAt: now() }); }
  async listOffers(campaignId: string) { await this.get(campaignId); return this.campaignOffers.listByCampaign(campaignId); }
  async removeOffer(campaignId: string, affiliateOfferId: string) { await this.get(campaignId); await this.campaignOffers.remove(campaignId, affiliateOfferId); }
}

export class TrackingService {
  constructor(private readonly links: TrackingLinkRepository, private readonly clicks: ClickRepository, private readonly campaigns: Repository<Campaign>, private readonly affiliateOffers: AffiliateOfferRepository, private readonly campaignOffers: CampaignOfferRepository) {}
  async list(campaignId?: string) {
    if (campaignId) await this.getCampaign(campaignId);
    return campaignId ? this.links.listByCampaign(campaignId) : this.links.list();
  }
  private async getCampaign(id: string) { const campaign = await this.campaigns.findById(id); if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404); return campaign; }
  async create(input: CreateTrackingLinkRequest) {
    const offer = await this.affiliateOffers.findById(input.affiliateOfferId);
    if (!offer) throw new DomainError("AFFILIATE_OFFER_NOT_FOUND", "The affiliate offer does not exist.", 404);
    if (offer.status !== "active") throw new DomainError("AFFILIATE_OFFER_NOT_ACTIVE", "Tracking links require an active affiliate offer.");
    if (input.campaignId) {
      await this.getCampaign(input.campaignId);
      if (!(await this.campaignOffers.find(input.campaignId, input.affiliateOfferId))) throw new DomainError("OFFER_NOT_ATTACHED", "The affiliate offer must be attached to the campaign first.");
    }
    const createdAt = now();
    const link: TrackingLink = { id: randomUUID(), affiliateOfferId: input.affiliateOfferId, campaignId: input.campaignId, code: input.code ?? code(), destinationUrl: input.destinationUrl, status: "active", createdAt, updatedAt: createdAt };
    if (await this.links.findByCode(link.code)) throw new DomainError("TRACKING_CODE_EXISTS", "The tracking code is already in use.", 409);
    try {
      return await this.links.save(link);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError("TRACKING_CODE_EXISTS", "The tracking code is already in use.", 409);
      throw error;
    }
  }
  async get(id: string) { const link = await this.links.findById(id); if (!link) throw new DomainError("TRACKING_LINK_NOT_FOUND", "The tracking link does not exist.", 404); return link; }
  async recordClick(id: string, input: RecordClickRequest) {
    const link = await this.get(id);
    if (link.status !== "active") throw new DomainError("TRACKING_LINK_NOT_ACTIVE", "Clicks require an active tracking link.");
    const idempotencyKey = input.idempotencyKey?.trim();
    const existing = idempotencyKey ? (await this.clicks.listByTrackingLink(id)).find((click) => click.metadata.idempotencyKey === idempotencyKey) : undefined;
    if (existing) return existing;
    return this.clicks.save({ id: randomUUID(), trackingLinkId: link.id, occurredAt: input.occurredAt ?? now(), metadata: { ...(input.metadata ?? {}), ...(idempotencyKey ? { idempotencyKey } : {}) } });
  }
  async stats(id: string): Promise<TrackingLinkStats> { await this.get(id); return { linkId: id, clickCount: (await this.clicks.listByTrackingLink(id)).length }; }
}
