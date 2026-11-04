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
  createdAt: string;
  updatedAt: string;
}

export interface ProductMediaCandidateRepository {
  saveMany(candidates: ProductMediaCandidateRecord[]): Promise<ProductMediaCandidateRecord[]>;
  listPendingByProduct(productId: string, limit?: number): Promise<ProductMediaCandidateRecord[]>;
}
