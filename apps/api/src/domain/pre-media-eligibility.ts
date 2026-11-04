export interface PreMediaEligibilityEvidence {
  id: string;
  cycleId: string;
  productId: string;
  marketplaceId: string;
  offerId?: string;
  eligible: boolean;
  score: number;
  policy: Record<string, unknown>;
  reasons: string[];
  createdAt: string;
}

export interface PreMediaEligibilityRepository {
  saveMany(records: PreMediaEligibilityEvidence[]): Promise<void>;
  listLatestByProduct(productId: string, limit?: number): Promise<PreMediaEligibilityEvidence[]>;
}
