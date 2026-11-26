import { eq } from "drizzle-orm";
import { generatedProductCreatives, illustrativeCreativePolicies } from "./schema.js";
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
      durationMs: row.durationMs
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
      productSnapshot: row.productSnapshot, widthPx: row.widthPx, heightPx: row.heightPx, durationMs: row.durationMs
    };
  }

  async getPolicy(platform: "instagram"): Promise<{ platform: "instagram"; enabled: boolean; terms: Record<string, unknown> } | undefined> {
    const rows = await this.db.select({
      platform: illustrativeCreativePolicies.platform,
      enabled: illustrativeCreativePolicies.enabled,
      terms: illustrativeCreativePolicies.terms
    }).from(illustrativeCreativePolicies)
      .where(eq(illustrativeCreativePolicies.platform, platform)).limit(1);
    const row = rows[0];
    return row ? { platform: "instagram", enabled: row.enabled, terms: row.terms as Record<string, unknown> } : undefined;
  }

  async isEnabled(platform: "instagram"): Promise<boolean> {
    const rows = await this.db.select({ enabled: illustrativeCreativePolicies.enabled })
      .from(illustrativeCreativePolicies)
      .where(eq(illustrativeCreativePolicies.platform, platform)).limit(1);
    return rows[0]?.enabled === true;
  }
}
