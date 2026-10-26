import { randomUUID } from "node:crypto";
import type { Campaign, Content, CreateContentRequest, CreateSocialAccountRequest, Product, SocialAccount, SocialAccountView, UpdateContentRequest } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import { isPublicMediaUrl, type MediaAssetRepository } from "./media-asset.js";
import type { Repository, SocialAccountRepository } from "./repository.js";

const now = () => new Date().toISOString();

const contentTransitions: Record<Content["status"], Content["status"][]> = {
  draft: ["draft", "scheduled", "archived"], scheduled: ["scheduled", "published", "failed", "draft", "archived"], published: ["published", "archived"], failed: ["failed", "scheduled", "draft", "archived"], archived: ["archived"]
};
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505"); }
function validateContentTiming(status: Content["status"], scheduledAt: string | undefined, publishedAt: string | undefined) { if (status === "scheduled" && !scheduledAt) throw new DomainError("CONTENT_SCHEDULE_REQUIRED", "Scheduled content requires scheduledAt."); if (status === "published" && !publishedAt) throw new DomainError("CONTENT_PUBLISHED_AT_REQUIRED", "Published content requires publishedAt."); if (scheduledAt && publishedAt && Date.parse(scheduledAt) > Date.parse(publishedAt)) throw new DomainError("INVALID_CONTENT_DATES", "scheduledAt must be before publishedAt."); }
function validateContentTransition(current: Content["status"], next: Content["status"] | undefined) { if (next && !contentTransitions[current].includes(next)) throw new DomainError("INVALID_CONTENT_TRANSITION", `Content cannot transition from ${current} to ${next}.`); }
const sensitiveConnectionKey = /(?:password|passcode|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|signing[_-]?key)/i;
export function redactSensitiveConnectionValues(value: unknown): unknown { if (Array.isArray(value)) return value.map((item) => redactSensitiveConnectionValues(item)); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sensitiveConnectionKey.test(key) ? "[REDACTED]" : redactSensitiveConnectionValues(nested)])); }
function isOpaqueCredentialReference(value: string): boolean { return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\/-]+$/i.test(value) && !/\s/.test(value); }
export function validateOpaqueCredentialReference(value: string | undefined): void { if (value !== undefined && (!value.trim() || !isOpaqueCredentialReference(value.trim()))) throw new DomainError("INVALID_SOCIAL_CREDENTIAL_REFERENCE", "Social credential references must be opaque secret-manager references.", 400); }

export class ContentService {
  constructor(private readonly contents: Repository<Content>, private readonly campaigns: Repository<Campaign>, private readonly products: Repository<Product>, private readonly mediaAssets?: MediaAssetRepository) {}
  async list(campaignId?: string) { const items = await this.contents.list(); if (campaignId) { await this.getCampaign(campaignId); return items.filter((item) => item.campaignId === campaignId); } return items; }
  async get(id: string) { const content = await this.contents.findById(id); if (!content) throw new DomainError("CONTENT_NOT_FOUND", "The content does not exist.", 404); return content; }
  async validateProductForPublication(productId: string): Promise<Product> {
    const product = await this.products.findById(productId);
    if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "The product does not exist.", 404);
    if (product.status !== "active") throw new DomainError("PRODUCT_NOT_ACTIVE", "Affiliate promotion content requires an active product.");
    return product;
  }
  async validatePublicationEligibility(content: Content): Promise<void> { if (content.contentType !== "affiliate-promotion" || !content.productId) return; await this.validateProductForPublication(content.productId); }
  async create(input: CreateContentRequest) { await this.validateReferences(input.campaignId, input.productId); const nextStatus = input.status ?? "draft"; validateContentTiming(nextStatus, input.scheduledAt, input.publishedAt); const draftContent = { productId: input.productId, contentType: input.contentType } as Content; if (nextStatus === "scheduled" || nextStatus === "published") await this.validatePublicationEligibility(draftContent); const createdAt = now(); return this.contents.save({ id: randomUUID(), productId: input.productId, campaignId: input.campaignId, socialAccountId: input.socialAccountId, mediaAssetIds: input.mediaAssetIds ? [...input.mediaAssetIds] : undefined, platform: input.platform, contentType: input.contentType, title: input.title, caption: input.caption, script: input.script, cta: input.cta, status: input.status ?? "draft", scheduledAt: input.scheduledAt, publishedAt: input.publishedAt, createdAt, updatedAt: createdAt }); }
  async attachProductMedia(id: string, kinds: Array<"image" | "video">) {
    if (!this.mediaAssets) throw new DomainError("CONTENT_MEDIA_UNAVAILABLE", "Content media assets are not configured.", 503);
    const content = await this.get(id);
    if (!content.productId) throw new DomainError("CONTENT_PRODUCT_REQUIRED", "Content must reference a product before product media can be attached.", 400);
    const product = await this.products.findById(content.productId);
    if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "The content product does not exist.", 404);
    const selected = [...new Set(kinds)].map((kind) => {
      const reference = kind === "image" ? product.imageUrl : product.videoUrl;
      if (!reference) throw new DomainError("PRODUCT_MEDIA_NOT_AVAILABLE", `The product has no ${kind} URL to attach.`, 409);
      if (!isPublicMediaUrl(reference)) throw new DomainError("INVALID_PRODUCT_MEDIA_URL", `Product ${kind} media must use a valid HTTPS URL.`, 400);
      return { kind, reference };
    });
    const existing = await this.mediaAssets.listByContent(content.id);
    const mediaAssetIds = [...(content.mediaAssetIds ?? [])];
    const attached: string[] = [];
    const nowAt = now();
    for (const { kind, reference } of selected) {
      let asset = existing.find((candidate) => candidate.kind === kind && candidate.source === "url" && candidate.reference === reference);
      if (!asset) {
        asset = await this.mediaAssets.save({ id: randomUUID(), contentId: content.id, kind, source: "url", reference, createdAt: nowAt, updatedAt: nowAt });
        existing.push(asset);
      }
      if (!mediaAssetIds.includes(asset.id)) mediaAssetIds.push(asset.id);
      attached.push(asset.id);
    }
    const updated = await this.update(content.id, { mediaAssetIds });
    return { content: updated, attachedMediaAssetIds: attached };
  }
  async update(id: string, input: UpdateContentRequest) { const current = await this.get(id); const productId = input.productId ?? current.productId; await this.validateReferences(input.campaignId ?? current.campaignId, productId); const nextStatus = input.status ?? current.status; validateContentTransition(current.status, input.status); validateContentTiming(nextStatus, input.scheduledAt ?? current.scheduledAt, input.publishedAt ?? current.publishedAt); const nextContent = { ...current, ...input, productId, mediaAssetIds: input.mediaAssetIds ? [...input.mediaAssetIds] : current.mediaAssetIds, updatedAt: now() }; if (nextStatus === "scheduled" || nextStatus === "published") await this.validatePublicationEligibility(nextContent); return this.contents.save(nextContent); }
  private async getCampaign(id: string) { const campaign = await this.campaigns.findById(id); if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", "The campaign does not exist.", 404); return campaign; }
  private async validateReferences(campaignId?: string, productId?: string) { if (campaignId) await this.getCampaign(campaignId); if (productId && !(await this.products.findById(productId))) throw new DomainError("PRODUCT_NOT_FOUND", "The product does not exist.", 404); }
}

export class SocialAccountService {
  constructor(private readonly accounts: SocialAccountRepository) {}
  private view(account: SocialAccount): SocialAccountView { const { credentialReference: _credentialReference, ...safe } = account; return { ...safe, connection: redactSensitiveConnectionValues(account.connection) as SocialAccount["connection"], hasCredentialReference: Boolean(account.credentialReference) }; }
  async list() { return (await this.accounts.list()).map((account) => this.view(account)); }
  async get(id: string) { const account = await this.accounts.findById(id); if (!account) throw new DomainError("SOCIAL_ACCOUNT_NOT_FOUND", "The social account does not exist.", 404); return this.view(account); }
  async create(input: CreateSocialAccountRequest) { validateOpaqueCredentialReference(input.credentialReference); if (await this.accounts.findByPlatformAccount(input.platform, input.accountReference)) throw new DomainError("SOCIAL_ACCOUNT_EXISTS", "The social account is already registered.", 409); const createdAt = now(); const account: SocialAccount = { id: randomUUID(), platform: input.platform, accountReference: input.accountReference, status: input.status ?? "pending", connection: input.connection ?? {}, credentialReference: input.credentialReference?.trim(), createdAt, updatedAt: createdAt }; try { return this.view(await this.accounts.save(account)); } catch (error) { if (isUniqueViolation(error)) throw new DomainError("SOCIAL_ACCOUNT_EXISTS", "The social account is already registered.", 409); throw error; } }
  async update(id: string, input: import("@affiliateos/shared").UpdateSocialAccountRequest) { const current = await this.accounts.findById(id); if (!current) throw new DomainError("SOCIAL_ACCOUNT_NOT_FOUND", "The social account does not exist.", 404); validateOpaqueCredentialReference(input.credentialReference); const platform = input.platform ?? current.platform; const accountReference = input.accountReference ?? current.accountReference; const duplicate = await this.accounts.findByPlatformAccount(platform, accountReference); if (duplicate && duplicate.id !== id) throw new DomainError("SOCIAL_ACCOUNT_EXISTS", "The social account is already registered.", 409); const updated: SocialAccount = { ...current, ...input, platform, accountReference, credentialReference: input.credentialReference === undefined ? current.credentialReference : input.credentialReference.trim(), updatedAt: now() }; try { return this.view(await this.accounts.save(updated)); } catch (error) { if (isUniqueViolation(error)) throw new DomainError("SOCIAL_ACCOUNT_EXISTS", "The social account is already registered.", 409); throw error; } }
  async rotateCredential(id: string, credentialReference: string) { const current = await this.accounts.findById(id); if (!current) throw new DomainError("SOCIAL_ACCOUNT_NOT_FOUND", "The social account does not exist.", 404); validateOpaqueCredentialReference(credentialReference); const rotated: SocialAccount = { ...current, status: "active", credentialReference: credentialReference.trim(), updatedAt: now() }; return this.view(await this.accounts.save(rotated)); }
  async revokeCredential(id: string) { const current = await this.accounts.findById(id); if (!current) throw new DomainError("SOCIAL_ACCOUNT_NOT_FOUND", "The social account does not exist.", 404); if (!current.credentialReference) return this.view(current); const revoked: SocialAccount = { ...current, status: "inactive", credentialReference: undefined, updatedAt: now() }; return this.view(await this.accounts.save(revoked)); }
}
