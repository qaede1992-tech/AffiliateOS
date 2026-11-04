import { and, desc, eq, sql } from "drizzle-orm";
import type { ProductMediaCandidateRecord, ProductMediaCandidateRepository } from "../domain/product-media-candidate.js";
import { productMediaCandidates } from "./schema.js";

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
  createdAt: row.createdAt, updatedAt: row.updatedAt
});

export class DrizzleProductMediaCandidateRepository implements ProductMediaCandidateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

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
      rightsStatus: "unverified"
    }))).onConflictDoUpdate({
      target: [
        productMediaCandidates.productId,
        productMediaCandidates.provider,
        productMediaCandidates.candidateHash
      ],
      // Refresh evidence only while the candidate is still awaiting human review.
      // Once identity or rights decisions have been made, preserve their evidence.
      setWhere: and(
        eq(productMediaCandidates.reviewStatus, "pending"),
        eq(productMediaCandidates.rightsStatus, "unverified")
      ),
      set: {
        query: sql`excluded.query`,
        title: sql`excluded.title`,
        imageUrl: sql`excluded.image_url`,
        landingPageUrl: sql`excluded.landing_page_url`,
        creator: sql`excluded.creator`,
        creatorUrl: sql`excluded.creator_url`,
        license: sql`excluded.license`,
        licenseVersion: sql`excluded.license_version`,
        licenseUrl: sql`excluded.license_url`,
        sourcePublisher: sql`excluded.source_publisher`,
        identityScore: sql`excluded.identity_score`,
        identityStatus: sql`excluded.identity_status`,
        identityReasons: sql`excluded.identity_reasons`,
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
}
