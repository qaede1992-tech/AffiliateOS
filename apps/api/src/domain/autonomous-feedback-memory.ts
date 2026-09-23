export type AutonomousFeedbackSnapshot = {
  id: string;
  observationKey: string;
  productId: string;
  marketplaceId: string;
  clickCount: number;
  conversionCount: number;
  attributedCommissionCents: number;
  commissionPerClickCents: number;
  conversionRate: number;
  adjustment: number;
  observedAt: string;
};

export interface AutonomousFeedbackMemoryRepository {
  save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot>;
  saveIfAbsent?(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot>;
  latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined>;
  latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined>;
}

export class InMemoryAutonomousFeedbackMemoryRepository implements AutonomousFeedbackMemoryRepository {
  private readonly snapshots = new Map<string, AutonomousFeedbackSnapshot>();
  private readonly byObservation = new Map<string, AutonomousFeedbackSnapshot>();

  async save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    this.snapshots.set(snapshot.id, snapshot);
    this.byObservation.set(snapshot.observationKey, snapshot);
    return snapshot;
  }

  async saveIfAbsent(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    const existing = this.byObservation.get(snapshot.observationKey);
    if (existing) return existing;
    return this.save(snapshot);
  }

  async latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.productId === productId)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id))[0];
  }

  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.productId === productId && snapshot.marketplaceId === marketplaceId)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id))[0];
  }
}
