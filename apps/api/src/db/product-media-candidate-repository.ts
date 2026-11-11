import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ProductMediaCandidateRecord, ProductMediaCandidateRepository, ProductMediaCandidateReviewAudit, ProductMediaCandidateReviewCommand } from "../domain/product-media-candidate.js";
import { productMediaCandidates, productMediaCandidateReviewAudits } from "./schema.js";

type DatabaseExecutor = any;
type CandidateRow = typeof productMediaCandidates.$inferSelect;

const toCandidate = (row: CandidateRow): ProductMediaCandidateRecord => ({
  id: row.id, productId: row.productId, provider: row.provider, candidateHash: row.candidateHash,
  query: row.query, title: row.title, imageUrl: row.imageUrl, landingPageUrl: row.landingPageUrl,
  creator: row.creator, creatorUrl: row.creatorUrl, license: row.license,
  licenseVersion: row.licenseVersion, licenseUrl: row.licenseUrl, sourcePublisher: row.sourcePublisher,
  identityScore: row.identityScore, identityStatus: row.identityStatus as ProductMediaCandidateRecord["identityStatus"],
  identityReasons: row.identityReasons, reviewStatus: row.reviewStatus as ProductMediaCandidateRecord["reviewStatus"],
  rightsStatus: row.rightsStatus as ProductMediaCandidateRecord["rightsStatus"],
  reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt, reviewReason: row.reviewReason,
  createdAt: row.createdAt, updatedAt: row.updatedAt
});

export class DrizzleProductMediaCandidateRepository implements ProductMediaCandidateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findById(candidateId: string): Promise<ProductMediaCandidateRecord | undefined> {
    const rows = await this.db.select().from(productMediaCandidates).where(eq(productMediaCandidates.id, candidateId)).limit(1);
    return rows[0] ? toCandidate(rows[0]) : undefined;
  }

  async saveMany(candidates: ProductMediaCandidateRecord[]): Promise<ProductMediaCandidateRecord[]> {
    if (candidates.length === 0) return [];
    const rows = await this.db.insert(productMediaCandidates).values(candidates.map((candidate) => ({
      ...candidate,
      creator: candidate.creator ?? null,
      creatorUrl: candidate.creatorUrl ?? null,
      license: candidate.license ?? null,
      licenseVersion: candidate.licenseVersion ?? null,
      licenseUrl: candidate.licenseUrl ?? null,
      sourcePublisher: candidate.sourcePublisher ?? null,
      identityReasons: candidate.identityReasons ?? [],
      reviewStatus: "pending",
      rightsStatus: "unverified",
      reviewedBy: null, reviewedAt: null, reviewReason: null
    }))).onConflictDoUpdate({
      target: [productMediaCandidates.productId, productMediaCandidates.provider, productMediaCandidates.candidateHash],
      setWhere: and(eq(productMediaCandidates.reviewStatus, "pending"), eq(productMediaCandidates.rightsStatus, "unverified")),
      set: {
        query: sql`excluded.query`, title: sql`excluded.title`, imageUrl: sql`excluded.image_url`,
        landingPageUrl: sql`excluded.landing_page_url`, creator: sql`excluded.creator`, creatorUrl: sql`excluded.creator_url`,
        license: sql`excluded.license`, licenseVersion: sql`excluded.license_version`, licenseUrl: sql`excluded.license_url`,
        sourcePublisher: sql`excluded.source_publisher`, identityScore: sql`excluded.identity_score`,
        identityStatus: sql`excluded.identity_status`, identityReasons: sql`excluded.identity_reasons`,
        updatedAt: sql`excluded.updated_at`
      }
    }).returning();
    return rows.map(toCandidate);
  }

  async listPendingByProduct(productId: string, limit = 20): Promise<ProductMediaCandidateRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.db.select().from(productMediaCandidates)
      .where(and(eq(productMediaCandidates.productId, productId), eq(productMediaCandidates.reviewStatus, "pending")))
      .orderBy(desc(productMediaCandidates.createdAt)).limit(boundedLimit);
    return rows.map(toCandidate);
  }

  async listByProductAndReviewStatus(
    productId: string,
    status: ProductMediaCandidateRecord["reviewStatus"],
    limit = 50
  ): Promise<ProductMediaCandidateRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.db.select().from(productMediaCandidates)
      .where(and(eq(productMediaCandidates.productId, productId), eq(productMediaCandidates.reviewStatus, status)))
      .orderBy(desc(productMediaCandidates.createdAt)).limit(boundedLimit);
    return rows.map(toCandidate);
  }

  async review(candidateId: string, productId: string, command: ProductMediaCandidateReviewCommand): Promise<ProductMediaCandidateRecord | undefined> {
    return this.db.transaction(async (tx: DatabaseExecutor) => {
      const rows = await tx.select().from(productMediaCandidates).where(and(
        eq(productMediaCandidates.id, candidateId),
        eq(productMediaCandidates.productId, productId),
        eq(productMediaCandidates.reviewStatus, "pending")
      )).limit(1).for("update");
      const existing = rows[0];
      if (!existing) return undefined;
      const reviewedAt = new Date().toISOString();
      const nextStatus = command.status;
      const updatedRows = await tx.update(productMediaCandidates).set({
        reviewStatus: nextStatus,
        reviewedBy: command.actorId,
        reviewedAt,
        reviewReason: command.reason,
        updatedAt: reviewedAt
      }).where(and(
        eq(productMediaCandidates.id, candidateId),
        eq(productMediaCandidates.productId, productId),
        eq(productMediaCandidates.reviewStatus, "pending")
      )).returning();
      const updated = updatedRows[0];
      if (!updated) return undefined;
      await tx.insert(productMediaCandidateReviewAudits).values({
        id: randomUUID(),
        candidateId,
        productId,
        actorId: command.actorId,
        actorRole: command.actorRole,
        action: nextStatus === "approved" ? "approve" : "reject",
        reason: command.reason,
        previousStatus: "pending",
        newStatus: nextStatus,
        createdAt: reviewedAt
      });
      return toCandidate(updated);
    });
  }

  async listReviewAudits(productId: string, candidateId: string, limit = 50): Promise<ProductMediaCandidateReviewAudit[]> {
    const rows = await this.db.select().from(productMediaCandidateReviewAudits).where(and(
      eq(productMediaCandidateReviewAudits.productId, productId),
      eq(productMediaCandidateReviewAudits.candidateId, candidateId)
    )).orderBy(desc(productMediaCandidateReviewAudits.createdAt)).limit(Math.max(1, Math.min(50, Math.trunc(limit))));
    return rows.map((row: typeof productMediaCandidateReviewAudits.$inferSelect) => ({
      id: row.id, candidateId: row.candidateId, productId: row.productId, actorId: row.actorId,
      actorRole: "admin", action: row.action as ProductMediaCandidateReviewAudit["action"],
      reason: row.reason, previousStatus: "pending", newStatus: row.newStatus as ProductMediaCandidateReviewAudit["newStatus"],
      createdAt: row.createdAt
    }));
  }
}
