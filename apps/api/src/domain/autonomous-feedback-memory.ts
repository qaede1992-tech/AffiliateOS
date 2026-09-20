export type AutonomousFeedbackSnapshot = {
  id: string;
  productId: string;
  clickCount: number;
  conversionCount: number;
  attributedCommissionCents: number;
  conversionRate: number;
  adjustment: number;
  observedAt: string;
};

export interface AutonomousFeedbackMemoryRepository {
  save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot>;
  latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined>;
}

export class InMemoryAutonomousFeedbackMemoryRepository implements AutonomousFeedbackMemoryRepository {
  private readonly snapshots = new Map<string, AutonomousFeedbackSnapshot>();

  async save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    this.snapshots.set(snapshot.productId, snapshot);
    return snapshot;
  }

  async latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    return this.snapshots.get(productId);
  }
}
