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
      storageKey: row.storageKey
    };
  }

  async isEnabled(platform: "instagram"): Promise<boolean> {
    const rows = await this.db.select({ enabled: illustrativeCreativePolicies.enabled })
      .from(illustrativeCreativePolicies)
      .where(eq(illustrativeCreativePolicies.platform, platform)).limit(1);
    return rows[0]?.enabled === true;
  }
}
