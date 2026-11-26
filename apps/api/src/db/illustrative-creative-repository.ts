import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { content, products, affiliateOffers, preMediaEligibilityEvidence, mediaAssets, generatedProductCreatives, generatedProductCreativeReviewAudits, illustrativeCreativePolicies } from "./schema.js";
import type { IllustrativeCreativeReader, IllustrativeCreativeRecord, IllustrativePolicyReader } from "../domain/illustrative-media-delivery.js";

type DatabaseExecutor = any;

export class DrizzleIllustrativeCreativeRepository implements IllustrativeCreativeReader, IllustrativePolicyReader {
  constructor(private readonly db: DatabaseExecutor) {}

  async findById(id: string): Promise<IllustrativeCreativeRecord | undefined> {
    const rows = await this.db.select().from(generatedProductCreatives)
      .where(eq(generatedProductCreatives.id, id)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      mediaAssetId: row.mediaAssetId,
      contentId: row.contentId,
      platform: row.platform,
      sha256: row.sha256,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      disclosureEmbedded: row.disclosureEmbedded,
      reviewStatus: row.reviewStatus,
      storageBackend: row.storageBackend,
      storageKey: row.storageKey,
      productId: row.productId,
      affiliateOfferId: row.affiliateOfferId,
      rendererVersion: row.rendererVersion,
      templateVersion: row.templateVersion,
      productSnapshot: row.productSnapshot,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      durationMs: row.durationMs,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      reviewReason: row.reviewReason
    };
  }

  async findByMediaAssetId(mediaAssetId: string): Promise<IllustrativeCreativeRecord | undefined> {
    const rows = await this.db.select().from(generatedProductCreatives)
      .where(eq(generatedProductCreatives.mediaAssetId, mediaAssetId)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id, mediaAssetId: row.mediaAssetId, contentId: row.contentId, platform: row.platform,
      sha256: row.sha256, mimeType: row.mimeType, byteSize: row.byteSize,
      disclosureEmbedded: row.disclosureEmbedded, reviewStatus: row.reviewStatus,
      storageBackend: row.storageBackend, storageKey: row.storageKey,
      productId: row.productId, affiliateOfferId: row.affiliateOfferId,
      rendererVersion: row.rendererVersion, templateVersion: row.templateVersion,
      productSnapshot: row.productSnapshot, widthPx: row.widthPx, heightPx: row.heightPx, durationMs: row.durationMs,
      reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt, reviewReason: row.reviewReason
    };
  }


  /**
   * Persist the local-volume media reference and its immutable creative provenance
   * in one database transaction. The caller writes the file first and removes it
   * if this transaction fails; no Supabase Storage write is performed here.
   */
  async createPending(input: {
    id: string;
    contentId: string;
    productId: string;
    affiliateOfferId: string;
    rendererVersion: string;
    templateVersion: string;
    sha256: string;
    productSnapshot: Record<string, unknown>;
    mimeType: "video/mp4";
    byteSize: number;
    widthPx: number;
    heightPx: number;
    durationMs: number;
    storageKey: string;
    disclosureEmbedded: true;
  }): Promise<IllustrativeCreativeRecord> {
    if (input.mimeType !== "video/mp4" || input.disclosureEmbedded !== true ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-f0-9]{64}\.mp4$/i.test(input.storageKey) ||
        ![input.byteSize, input.widthPx, input.heightPx, input.durationMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error("Generated creative metadata failed validation.");
    }
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const contentRows = await tx.select({
        id: content.id, productId: content.productId, platform: content.platform,
        contentType: content.contentType, status: content.status
      }).from(content).where(eq(content.id, input.contentId)).limit(1).for("update");
      const targetContent = contentRows[0];
      if (!targetContent || targetContent.productId !== input.productId ||
          targetContent.platform !== "instagram" || targetContent.contentType !== "affiliate-promotion" ||
          targetContent.status !== "draft") {
        throw new Error("Generated creative requires a draft Instagram affiliate-promotion for the same product.");
      }
      const offerRows = await tx.select({
        id: affiliateOffers.id, productId: affiliateOffers.productId, status: affiliateOffers.status,
        affiliateLinkStatus: affiliateOffers.affiliateLinkStatus
      }).from(affiliateOffers).where(eq(affiliateOffers.id, input.affiliateOfferId)).limit(1);
      const offer = offerRows[0];
      if (!offer || offer.productId !== input.productId || offer.status !== "active" || offer.affiliateLinkStatus !== "active") {
        throw new Error("Generated creative requires an active affiliate offer for the same product.");
      }
      const mediaAssetId = randomUUID();
      const now = new Date().toISOString();
      await tx.insert(mediaAssets).values({
        id: mediaAssetId, contentId: input.contentId, kind: "video", source: "generated",
        reference: `illustrative-creative:${input.id}`, mimeType: input.mimeType,
        byteSize: input.byteSize, durationSeconds: Math.ceil(input.durationMs / 1000),
        widthPx: input.widthPx, heightPx: input.heightPx, createdAt: now, updatedAt: now
      });
      const rows = await tx.insert(generatedProductCreatives).values({
        id: input.id, mediaAssetId, contentId: input.contentId, productId: input.productId,
        affiliateOfferId: input.affiliateOfferId, platform: "instagram",
        rendererVersion: input.rendererVersion, templateVersion: input.templateVersion,
        sha256: input.sha256, productSnapshot: input.productSnapshot,
        disclosureEmbedded: true, mimeType: input.mimeType, byteSize: input.byteSize,
        widthPx: input.widthPx, heightPx: input.heightPx, durationMs: input.durationMs,
        storageBackend: "local_volume", storageKey: input.storageKey,
        reviewStatus: "pending", createdAt: now, updatedAt: now
      }).returning();
      const row = rows[0];
      if (!row) throw new Error("Generated creative metadata was not persisted.");
      return this.toCreativeRecord(row);
    });
  }

  /** A decision and its audit row are committed atomically; only pending items can be reviewed. */
  async review(input: {
    creativeId: string;
    status: "approved" | "rejected";
    actorId: string;
    reason: string;
  }): Promise<IllustrativeCreativeRecord | undefined> {
    if (!input.actorId.trim() || !input.reason.trim() || input.reason.length > 1000) {
      throw new Error("A reviewer identity and a reason of at most 1000 characters are required.");
    }
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const existingRows = await tx.select().from(generatedProductCreatives)
        .where(eq(generatedProductCreatives.id, input.creativeId)).limit(1).for("update");
      const existing = existingRows[0];
      if (!existing || existing.reviewStatus !== "pending") return undefined;
      const reviewedAt = new Date().toISOString();
      const updatedRows = await tx.update(generatedProductCreatives).set({
        reviewStatus: input.status, reviewedBy: input.actorId,
        reviewedAt, reviewReason: input.reason, updatedAt: reviewedAt
      }).where(and(
        eq(generatedProductCreatives.id, input.creativeId),
        eq(generatedProductCreatives.reviewStatus, "pending")
      )).returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;
      await tx.insert(generatedProductCreativeReviewAudits).values({
        id: randomUUID(), creativeId: input.creativeId, actorId: input.actorId,
        actorRole: "admin", action: input.status === "approved" ? "approve" : "reject",
        reason: input.reason, previousStatus: existing.reviewStatus,
        newStatus: updated.reviewStatus, createdAt: reviewedAt
      });
      return this.toCreativeRecord(updated);
    });
  }

  async listReviewAudits(creativeId: string): Promise<Array<{
    id: string; creativeId: string; actorId: string; actorRole: string;
    action: string; reason: string; previousStatus: string; newStatus: string; createdAt: string;
  }>> {
    const rows = await this.db.select().from(generatedProductCreativeReviewAudits)
      .where(eq(generatedProductCreativeReviewAudits.creativeId, creativeId))
      .orderBy(desc(generatedProductCreativeReviewAudits.createdAt)).limit(50);
    return rows;
  }

  private toCreativeRecord(row: typeof generatedProductCreatives.$inferSelect): IllustrativeCreativeRecord {
    return {
      id: row.id, mediaAssetId: row.mediaAssetId, contentId: row.contentId,
      platform: row.platform, sha256: row.sha256, mimeType: row.mimeType,
      byteSize: row.byteSize, disclosureEmbedded: row.disclosureEmbedded,
      reviewStatus: row.reviewStatus, storageBackend: row.storageBackend,
      storageKey: row.storageKey, productId: row.productId,
      affiliateOfferId: row.affiliateOfferId, rendererVersion: row.rendererVersion,
      templateVersion: row.templateVersion, productSnapshot: row.productSnapshot,
      widthPx: row.widthPx, heightPx: row.heightPx, durationMs: row.durationMs,
      reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt, reviewReason: row.reviewReason
    };
  }

  async getPolicy(platform: "instagram"): Promise<{ platform: "instagram"; enabled: boolean; policyVersion: string; approvedBy: string | null; approvedAt: string | null; terms: Record<string, unknown> } | undefined> {
    const rows = await this.db.select({
      platform: illustrativeCreativePolicies.platform,
      enabled: illustrativeCreativePolicies.enabled,
      policyVersion: illustrativeCreativePolicies.policyVersion,
      approvedBy: illustrativeCreativePolicies.approvedBy,
      approvedAt: illustrativeCreativePolicies.approvedAt,
      terms: illustrativeCreativePolicies.terms
    }).from(illustrativeCreativePolicies)
      .where(eq(illustrativeCreativePolicies.platform, platform)).limit(1);
    const row = rows[0];
    return row ? { platform: "instagram", enabled: row.enabled, policyVersion: row.policyVersion, approvedBy: row.approvedBy, approvedAt: row.approvedAt, terms: row.terms as Record<string, unknown> } : undefined;
  }

  async isEnabled(platform: "instagram"): Promise<boolean> {
    const rows = await this.db.select({ enabled: illustrativeCreativePolicies.enabled })
      .from(illustrativeCreativePolicies)
      .where(eq(illustrativeCreativePolicies.platform, platform)).limit(1);
    return rows[0]?.enabled === true;
  }
}
