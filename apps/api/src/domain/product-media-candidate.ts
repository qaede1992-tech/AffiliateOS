export interface ProductMediaCandidateRecord {
  id: string;
  productId: string;
  provider: string;
  candidateHash: string;
  query: string;
  title: string;
  imageUrl: string;
  landingPageUrl: string;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseVersion: string | null;
  licenseUrl: string | null;
  sourcePublisher: string | null;
  identityScore: number;
  identityStatus: "strong_match" | "review_required";
  identityReasons: string[];
  reviewStatus: "pending" | "approved" | "rejected";
  rightsStatus: "unverified" | "verified" | "revoked";
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductMediaCandidateRepository {
  findById?(candidateId: string): Promise<ProductMediaCandidateRecord | undefined>;
  saveMany(candidates: ProductMediaCandidateRecord[]): Promise<ProductMediaCandidateRecord[]>;
  listPendingByProduct(productId: string, limit?: number): Promise<ProductMediaCandidateRecord[]>;
  listByProductAndReviewStatus?(productId: string, status: ProductMediaCandidateRecord["reviewStatus"], limit?: number): Promise<ProductMediaCandidateRecord[]>;
  review(candidateId: string, productId: string, command: ProductMediaCandidateReviewCommand): Promise<ProductMediaCandidateRecord | undefined>;
  listReviewAudits(productId: string, candidateId: string, limit?: number): Promise<ProductMediaCandidateReviewAudit[]>;
}


export interface ProductMediaCandidateReviewCommand {
  status: "approved" | "rejected";
  actorId: string;
  actorRole: "admin";
  reason: string;
}

export interface ProductMediaCandidateReviewAudit {
  id: string;
  candidateId: string;
  productId: string;
  actorId: string;
  actorRole: "admin";
  action: "approve" | "reject";
  reason: string;
  previousStatus: "pending";
  newStatus: "approved" | "rejected";
  createdAt: string;
}
