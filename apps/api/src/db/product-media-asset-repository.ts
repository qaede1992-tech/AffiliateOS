import { and, eq, inArray } from "drizzle-orm";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../domain/product-media-ingestion.js";
import { productMediaAssets } from "./schema.js";

type DatabaseExecutor = any;

const toAsset = (row: typeof productMediaAssets.$inferSelect): ProductMediaAsset => ({
  id: row.id,
  productId: row.productId,
  kind: row.kind as ProductMediaAsset["kind"],
  bucket: row.bucket,
  objectKey: row.objectKey,
  mimeType: row.mimeType as ProductMediaAsset["mimeType"],
  byteSize: row.byteSize,
  sha256: row.sha256,
  sourceUrl: row.sourceUrl,
  createdAt: row.createdAt
});

export class DrizzleProductMediaAssetRepository implements ProductMediaAssetRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findByProductAndHash(productId: string, sha256: string): Promise<ProductMediaAsset | undefined> {
    const rows = await this.db.select().from(productMediaAssets).where(and(
      eq(productMediaAssets.productId, productId),
      eq(productMediaAssets.sha256, sha256)
    )).limit(1);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  async listByProduct(productId: string): Promise<ProductMediaAsset[]> {
    return (await this.db.select().from(productMediaAssets).where(eq(productMediaAssets.productId, productId)))
      .map(toAsset);
  }

  async listProductIdsWithVideo(productIds: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(productIds)];
    if (!uniqueIds.length) return [];
    const rows = await this.db.select({ productId: productMediaAssets.productId })
      .from(productMediaAssets)
      .where(and(inArray(productMediaAssets.productId, uniqueIds), eq(productMediaAssets.kind, "video")));
    const matchedProductIds = (rows as Array<{ productId: string }>).map((row) => row.productId);
    return [...new Set(matchedProductIds)];
  }

  async save(asset: ProductMediaAsset): Promise<ProductMediaAsset> {
    const rows = await this.db.insert(productMediaAssets).values({
      ...asset,
      createdAt: asset.createdAt
    }).onConflictDoNothing().returning();
    if (rows[0]) return toAsset(rows[0]);
    const existing = await this.findByProductAndHash(asset.productId, asset.sha256);
    if (existing) return existing;
    throw new Error("Product media metadata conflicted with an existing storage key.");
  }
}
