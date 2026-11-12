import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaRightsAudit, ProductMediaRightsReviewCommand } from "../domain/product-media-ingestion.js";
import { productMediaAssets, productMediaRightsAudits } from "./schema.js";

type DatabaseExecutor = any;

const toAsset = (row: typeof productMediaAssets.$inferSelect): ProductMediaAsset => ({
  id: row.id,
  productId: row.productId,
  kind: row.kind as ProductMediaAsset["kind"],
  bucket: row.bucket,
  objectKey: row.objectKey,
  mimeType: row.mimeType as ProductMediaAsset["mimeType"],
  byteSize: row.byteSize,
  width: row.width,
  height: row.height,
  durationMs: row.durationMs,
  hasAudio: row.hasAudio,
  sha256: row.sha256,
  sourceUrl: row.sourceUrl,
  sourcePublisher: row.sourcePublisher,
  sourceProvider: row.sourceProvider,
  sourceCandidateId: row.sourceCandidateId,
  sourceLandingPageUrl: row.sourceLandingPageUrl,
  sourceTitle: row.sourceTitle,
  sourceQuery: row.sourceQuery,
  sourceCreator: row.sourceCreator,
  sourceCreatorUrl: row.sourceCreatorUrl,
  sourceLicense: row.sourceLicense,
  sourceLicenseVersion: row.sourceLicenseVersion,
  sourceLicenseUrl: row.sourceLicenseUrl,
  rightsStatus: row.rightsStatus as ProductMediaAsset["rightsStatus"],
  rightsBasis: row.rightsBasis as ProductMediaAsset["rightsBasis"],
  rightsEvidenceUrl: row.rightsEvidenceUrl,
  rightsVerifiedAt: row.rightsVerifiedAt,
  identityStatus: row.identityStatus as ProductMediaAsset["identityStatus"],
  identityReviewedBy: row.identityReviewedBy,
  identityReviewedAt: row.identityReviewedAt,
  identityReviewReason: row.identityReviewReason,
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

  async findBySourceCandidateId(candidateId: string): Promise<ProductMediaAsset | undefined> {
    const rows = await this.db.select().from(productMediaAssets).where(eq(productMediaAssets.sourceCandidateId, candidateId)).limit(1);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  async attachCandidateProvenance(
    productId: string,
    sha256: string,
    sourceUrl: string,
    provenance: NonNullable<Parameters<NonNullable<ProductMediaAssetRepository["attachCandidateProvenance"]>>[3]>
  ): Promise<ProductMediaAsset | undefined> {
    const rows = await this.db.update(productMediaAssets).set({
      sourceUrl,
      sourceProvider: provenance.provider,
      sourceCandidateId: provenance.candidateId,
      sourceLandingPageUrl: provenance.landingPageUrl,
      sourceTitle: provenance.title,
      sourceQuery: provenance.query,
      sourceCreator: provenance.creator,
      sourceCreatorUrl: provenance.creatorUrl,
      sourceLicense: provenance.license,
      sourceLicenseVersion: provenance.licenseVersion,
      sourceLicenseUrl: provenance.licenseUrl,
      sourcePublisher: provenance.sourcePublisher
    }).where(and(
      eq(productMediaAssets.productId, productId),
      eq(productMediaAssets.sha256, sha256),
      eq(productMediaAssets.rightsStatus, "unverified"),
      isNull(productMediaAssets.sourceCandidateId)
    )).returning();
    if (rows[0]) return toAsset(rows[0]);
    return this.findBySourceCandidateId(provenance.candidateId);
  }

  async listByProduct(productId: string): Promise<ProductMediaAsset[]> {
    return (await this.db.select().from(productMediaAssets).where(eq(productMediaAssets.productId, productId)))
      .map(toAsset);
  }

  async listByProducts(productIds: string[]): Promise<ProductMediaAsset[]> {
    const uniqueProductIds = [...new Set(productIds)];
    if (uniqueProductIds.length === 0) return [];
    return (await this.db.select().from(productMediaAssets).where(inArray(productMediaAssets.productId, uniqueProductIds)))
      .map(toAsset);
  }

  async reviewRights(assetId: string, productId: string, review: ProductMediaRightsReviewCommand): Promise<ProductMediaAsset | undefined> {
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const existingRows = await tx.select().from(productMediaAssets).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId)
      )).limit(1).for("update");
      const existing = existingRows[0];
      if (!existing) return undefined;

      const reviewedAt = new Date().toISOString();
      const rightsUpdate = review.status === "verified"
        ? {
            rightsStatus: "verified",
            rightsBasis: review.rightsBasis ?? null,
            rightsEvidenceUrl: review.rightsEvidenceUrl ?? null,
            rightsVerifiedAt: reviewedAt,
            sourcePublisher: review.sourcePublisher ?? null
          }
        : { rightsStatus: "revoked" };

      const updatedRows = await tx.update(productMediaAssets).set(rightsUpdate).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId)
      )).returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;

      await tx.insert(productMediaRightsAudits).values({
        id: randomUUID(),
        assetId,
        productId,
        actorId: review.actorId,
        actorRole: review.actorRole,
        action: review.status === "verified" ? "verify" : "revoke",
        reason: review.reason,
        previousRightsStatus: existing.rightsStatus,
        newRightsStatus: updated.rightsStatus,
        rightsBasis: updated.rightsBasis,
        rightsEvidenceUrl: updated.rightsEvidenceUrl,
        sourcePublisher: updated.sourcePublisher,
        createdAt: reviewedAt
      });
      return toAsset(updated);
    });
  }

  async listRightsAudits(productId: string, assetId: string): Promise<ProductMediaRightsAudit[]> {
    const rows = await this.db.select().from(productMediaRightsAudits).where(and(
      eq(productMediaRightsAudits.productId, productId),
      eq(productMediaRightsAudits.assetId, assetId)
    )).orderBy(desc(productMediaRightsAudits.createdAt)).limit(50);
    return rows.map((row: typeof productMediaRightsAudits.$inferSelect) => ({
      id: row.id,
      assetId: row.assetId,
      productId: row.productId,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action as ProductMediaRightsAudit["action"],
      reason: row.reason,
      previousRightsStatus: row.previousRightsStatus,
      newRightsStatus: row.newRightsStatus,
      rightsBasis: row.rightsBasis as ProductMediaRightsAudit["rightsBasis"],
      rightsEvidenceUrl: row.rightsEvidenceUrl,
      sourcePublisher: row.sourcePublisher,
      createdAt: row.createdAt
    }));
  }

  async save(asset: ProductMediaAsset): Promise<ProductMediaAsset> {
    const rows = await this.db.insert(productMediaAssets).values({
      ...asset,
      createdAt: asset.createdAt
    }).onConflictDoNothing().returning();
    if (rows[0]) return toAsset(rows[0]);
    const existing = await this.findByProductAndHash(asset.productId, asset.sha256)
      ?? (asset.sourceCandidateId ? await this.findBySourceCandidateId(asset.sourceCandidateId) : undefined);
    if (existing) return existing;
    throw new Error("Product media metadata conflicted with an existing storage key.");
  }
}
