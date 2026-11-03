import { desc, eq } from "drizzle-orm";
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
    }))).onConflictDoNothing().returning();
    return rows.map(toCandidate);
  }

  async listPendingByProduct(productId: string, limit = 20): Promise<ProductMediaCandidateRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.db.select().from(productMediaCandidates)
      .where(eq(productMediaCandidates.productId, productId))
      .orderBy(desc(productMediaCandidates.createdAt)).limit(boundedLimit);
    return rows.map(toCandidate);
  }
}
