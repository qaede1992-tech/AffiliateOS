import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaRightsAudit, ProductMediaRightsReviewCommand, ProductMediaIdentityAudit, ProductMediaIdentityReviewCommand, ProductMediaDeletionRequestCommand, ProductMediaDeletionBlockedError } from "../domain/product-media-ingestion.js";
import { mediaAssets, productMediaAssets, productMediaRightsAudits, productMediaIdentityAudits, productMediaDeletionAudits, publicationDispatchReservations } from "./schema.js";
import { validateProductMediaRightsEvidenceBinding } from "../domain/product-media-rights-evidence-binding.js";

type DatabaseExecutor = any;

const toAsset = (row: typeof productMediaAssets.$inferSelect): ProductMediaAsset => ({
  id: row.id,
  productId: row.productId,
  kind: row.kind as ProductMediaAsset["kind"],
  bucket: row.bucket,
  storageBackend: row.storageBackend as ProductMediaAsset["storageBackend"],
  objectKey: row.objectKey,
  mimeType: row.mimeType as ProductMediaAsset["mimeType"],
  byteSize: row.byteSize,
  width: row.width,
  height: row.height,
  durationMs: row.durationMs,
  hasAudio: row.hasAudio,
  sha256: row.sha256,
  sourceUrl: row.sourceUrl,
  sourceImportProvider: row.sourceImportProvider,
  sourceImportReference: row.sourceImportReference,
  sourceImportedAt: row.sourceImportedAt,
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
  deletionStatus: row.deletionStatus as ProductMediaAsset["deletionStatus"],
  deletedAt: row.deletedAt,
  deletedBy: row.deletedBy,
  deletionReason: row.deletionReason,
  storageCleanupCompletedAt: row.storageCleanupCompletedAt,
  storageCleanupAttempts: row.storageCleanupAttempts,
  storageCleanupNextAttemptAt: row.storageCleanupNextAttemptAt,
  storageCleanupLeaseUntil: row.storageCleanupLeaseUntil,
  storageCleanupLastError: row.storageCleanupLastError,
  createdAt: row.createdAt
});

export class DrizzleProductMediaAssetRepository implements ProductMediaAssetRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findById(id: string): Promise<ProductMediaAsset | undefined> {
    const rows = await this.db.select().from(productMediaAssets)
      .where(eq(productMediaAssets.id, id)).limit(1);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

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

  async findByProductAndSourceUrl(
    productId: string,
    sourceUrl: string,
    kind: ProductMediaAsset["kind"]
  ): Promise<ProductMediaAsset | undefined> {
    const rows = await this.db.select().from(productMediaAssets).where(and(
      eq(productMediaAssets.productId, productId),
      eq(productMediaAssets.sourceUrl, sourceUrl),
      eq(productMediaAssets.kind, kind)
    )).limit(1);
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
    return (await this.db.select().from(productMediaAssets).where(and(eq(productMediaAssets.productId, productId), eq(productMediaAssets.deletionStatus, "active"))))
      .map(toAsset);
  }

  async listByProducts(productIds: string[]): Promise<ProductMediaAsset[]> {
    const uniqueProductIds = [...new Set(productIds)];
    if (uniqueProductIds.length === 0) return [];
    return (await this.db.select().from(productMediaAssets).where(and(inArray(productMediaAssets.productId, uniqueProductIds), eq(productMediaAssets.deletionStatus, "active"))))
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

      if (review.status === "verified") {
        validateProductMediaRightsEvidenceBinding(toAsset(existing), review);
      }

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

  async reviewIdentity(assetId: string, productId: string, review: ProductMediaIdentityReviewCommand): Promise<ProductMediaAsset | undefined> {
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const existingRows = await tx.select().from(productMediaAssets).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId)
      )).limit(1).for("update");
      const existing = existingRows[0];
      if (!existing) return undefined;
      if (existing.sourceProvider !== "openai" || !existing.sourceUrl.startsWith("generated:openai-image-edit:")) return undefined;

      const reviewedAt = new Date().toISOString();
      const updatedRows = await tx.update(productMediaAssets).set({
        identityStatus: review.status,
        identityReviewedBy: review.actorId,
        identityReviewedAt: reviewedAt,
        identityReviewReason: review.reason
      }).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId)
      )).returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;

      await tx.insert(productMediaIdentityAudits).values({
        id: randomUUID(),
        assetId,
        productId,
        actorId: review.actorId,
        actorRole: review.actorRole,
        action: review.status === "verified" ? "verify" : "reject",
        reason: review.reason,
        previousIdentityStatus: existing.identityStatus,
        newIdentityStatus: updated.identityStatus,
        createdAt: reviewedAt
      });
      return toAsset(updated);
    });
  }

  async listIdentityAudits(productId: string, assetId: string): Promise<ProductMediaIdentityAudit[]> {
    const rows = await this.db.select().from(productMediaIdentityAudits).where(and(
      eq(productMediaIdentityAudits.productId, productId),
      eq(productMediaIdentityAudits.assetId, assetId)
    )).orderBy(desc(productMediaIdentityAudits.createdAt)).limit(50);
    return rows.map((row: typeof productMediaIdentityAudits.$inferSelect) => ({
      id: row.id,
      assetId: row.assetId,
      productId: row.productId,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action as ProductMediaIdentityAudit["action"],
      reason: row.reason,
      previousIdentityStatus: row.previousIdentityStatus,
      newIdentityStatus: row.newIdentityStatus,
      createdAt: row.createdAt
    }));
  }

  async requestDeletion(assetId: string, productId: string, command: ProductMediaDeletionRequestCommand): Promise<ProductMediaAsset | undefined> {
    const actorId = command.actorId.trim();
    const reason = command.reason.trim();
    if (!actorId || actorId.length > 255 || !reason || reason.length > 1000 || command.actorRole !== "admin") {
      throw new Error("A valid administrator and deletion reason are required.");
    }

    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const rows = await tx.select().from(productMediaAssets).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId)
      )).limit(1).for("update");
      const existing = rows[0];
      if (!existing) return undefined;
      if ((existing.deletionStatus ?? "active") !== "active") return toAsset(existing);

      const reference = `${existing.bucket}/${existing.objectKey}`;
      const attached = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(and(
        eq(mediaAssets.source, "object-storage"),
        eq(mediaAssets.reference, reference)
      )).limit(1);
      if (attached.length > 0) throw new ProductMediaDeletionBlockedError("ASSET_ATTACHED_TO_CONTENT");

      const activeReservations = await tx.select({ id: publicationDispatchReservations.id })
        .from(publicationDispatchReservations)
        .where(and(
          inArray(publicationDispatchReservations.state, ["reserved", "dispatching", "accepted", "uncertain", "needs_reconciliation"]),
          sql`(${publicationDispatchReservations.snapshot} #> '{mediaIntegrity,productMediaAssets}') @> ${JSON.stringify([{ id: assetId }])}::jsonb`
        ))
        .limit(1);
      if (activeReservations.length > 0) {
        throw new ProductMediaDeletionBlockedError("ACTIVE_PUBLICATION_RESERVATION");
      }

      const deletedAt = new Date().toISOString();
      const updatedRows = await tx.update(productMediaAssets).set({
        deletionStatus: "pending_cleanup",
        deletedAt,
        deletedBy: actorId,
        deletionReason: reason,
        storageCleanupAttempts: 0,
        storageCleanupNextAttemptAt: deletedAt,
        storageCleanupLeaseUntil: null,
        storageCleanupLastError: null,
        storageCleanupCompletedAt: null
      }).where(and(
        eq(productMediaAssets.id, assetId),
        eq(productMediaAssets.productId, productId),
        eq(productMediaAssets.deletionStatus, "active")
      )).returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;

      await tx.insert(productMediaDeletionAudits).values({
        id: randomUUID(),
        assetId,
        productId,
        actorId,
        actorRole: "admin",
        reason,
        storageBackend: updated.storageBackend ?? "supabase",
        bucket: updated.bucket,
        objectKey: updated.objectKey,
        createdAt: deletedAt
      });
      return toAsset(updated);
    });
  }

  async claimDeletionCleanupBatch(input: { limit: number; now: string; leaseUntil: string }): Promise<ProductMediaAsset[]> {
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit)));
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const candidates = await tx.select().from(productMediaAssets).where(and(
        inArray(productMediaAssets.deletionStatus, ["pending_cleanup", "cleanup_failed"]),
        or(isNull(productMediaAssets.storageCleanupLeaseUntil), lte(productMediaAssets.storageCleanupLeaseUntil, input.now)),
        or(isNull(productMediaAssets.storageCleanupNextAttemptAt), lte(productMediaAssets.storageCleanupNextAttemptAt, input.now))
      )).orderBy(asc(productMediaAssets.deletedAt), asc(productMediaAssets.createdAt))
        .limit(limit).for("update", { skipLocked: true });
      if (candidates.length === 0) return [];
      const updated = await tx.update(productMediaAssets).set({
        storageCleanupLeaseUntil: input.leaseUntil,
        storageCleanupAttempts: sql`${productMediaAssets.storageCleanupAttempts} + 1`
      }).where(inArray(productMediaAssets.id, candidates.map((asset: typeof productMediaAssets.$inferSelect) => asset.id))).returning();
      return updated.map(toAsset);
    });
  }

  async completeDeletionCleanup(input: { assetId: string; leaseUntil: string; completedAt: string }): Promise<boolean> {
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const rows = await tx.update(productMediaAssets).set({
        deletionStatus: "deleted",
        storageCleanupCompletedAt: input.completedAt,
        storageCleanupLeaseUntil: null,
        storageCleanupNextAttemptAt: null,
        storageCleanupLastError: null
      }).where(and(
        eq(productMediaAssets.id, input.assetId),
        eq(productMediaAssets.storageCleanupLeaseUntil, input.leaseUntil),
        inArray(productMediaAssets.deletionStatus, ["pending_cleanup", "cleanup_failed"])
      )).returning();
      const asset = rows[0];
      if (!asset) return false;
      await tx.insert(productMediaDeletionAudits).values({
        id: randomUUID(),
        assetId: asset.id,
        productId: asset.productId,
        actorId: "affiliateos:media-cleanup-worker",
        actorRole: "system",
        reason: "storage_cleanup_completed",
        storageBackend: asset.storageBackend ?? "supabase",
        bucket: asset.bucket,
        objectKey: asset.objectKey,
        createdAt: input.completedAt
      });
      return true;
    });
  }

  async failDeletionCleanup(input: { assetId: string; leaseUntil: string; failedAt: string; nextAttemptAt: string; errorType: string }): Promise<boolean> {
    const errorType = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.errorType) ? input.errorType : "UnknownError";
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const rows = await tx.update(productMediaAssets).set({
        deletionStatus: "cleanup_failed",
        storageCleanupLeaseUntil: null,
        storageCleanupNextAttemptAt: input.nextAttemptAt,
        storageCleanupLastError: errorType
      }).where(and(
        eq(productMediaAssets.id, input.assetId),
        eq(productMediaAssets.storageCleanupLeaseUntil, input.leaseUntil),
        inArray(productMediaAssets.deletionStatus, ["pending_cleanup", "cleanup_failed"])
      )).returning();
      const asset = rows[0];
      if (!asset) return false;
      await tx.insert(productMediaDeletionAudits).values({
        id: randomUUID(),
        assetId: asset.id,
        productId: asset.productId,
        actorId: "affiliateos:media-cleanup-worker",
        actorRole: "system",
        reason: `storage_cleanup_failed:${errorType}`,
        storageBackend: asset.storageBackend ?? "supabase",
        bucket: asset.bucket,
        objectKey: asset.objectKey,
        createdAt: input.failedAt
      });
      return true;
    });
  }

  async nextDeletionCleanupAt(): Promise<string | undefined> {
    const rows = await this.db.select({
      nextAt: sql<Date | string | null>`min(GREATEST(
        COALESCE(${productMediaAssets.storageCleanupNextAttemptAt}, now()),
        COALESCE(${productMediaAssets.storageCleanupLeaseUntil}, now())
      ))`
    }).from(productMediaAssets).where(inArray(productMediaAssets.deletionStatus, ["pending_cleanup", "cleanup_failed"]));
    const value = rows[0]?.nextAt;
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }

  async save(asset: ProductMediaAsset): Promise<ProductMediaAsset> {
    const rows = await this.db.insert(productMediaAssets).values({
      ...asset,
      storageBackend: asset.storageBackend ?? "supabase",
      createdAt: asset.createdAt
    }).onConflictDoNothing().returning();
    if (rows[0]) return toAsset(rows[0]);
    const existing = await this.findByProductAndHash(asset.productId, asset.sha256)
      ?? (asset.sourceCandidateId ? await this.findBySourceCandidateId(asset.sourceCandidateId) : undefined);
    if (existing) return existing;
    throw new Error("Product media metadata conflicted with an existing storage key.");
  }
}
