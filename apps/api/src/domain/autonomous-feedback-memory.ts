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
  anomaly: "none" | "watch" | "halt";
  anomalyScore: number;
  recoveryState: "none" | "recovering" | "recovered";
  recoveryClicks: number;
  recoveryEvidenceScore: number;
  recoveryQualityScore: number;
  recoveryPolicy?: { explorationFloor: number; direction: "hold-exploration" | "reduce-exploration" | "neutral"; qualityDelta?: number };
  recoveryEpisodeId?: string;
  observedAt: string;
};

export type RecoveryEpisodeAnalytics = { episodeId: string; startedAt: string; endedAt?: string; durationMs?: number; snapshotCount: number; recoveryClicks: number; conversionDelta: number; commissionDeltaCents: number; averageQualityScore: number; closingQualityScore?: number; closed: boolean; };
export type RecoveryEpisodeComparison = { current: RecoveryEpisodeAnalytics; previous?: RecoveryEpisodeAnalytics; qualityDelta?: number; durationDeltaMs?: number; commissionDeltaCentsDelta?: number; conversionDeltaDelta?: number; };

export interface AutonomousFeedbackMemoryRepository {
  save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot>;
  saveIfAbsent?(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot>;
  latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined>;
  latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined>;
  recentByProductAndMarketplace?(productId: string, marketplaceId: string, since: string): Promise<AutonomousFeedbackSnapshot[]>;
  recoveryEpisodeAnalytics?(productId: string, marketplaceId: string, episodeId: string): Promise<RecoveryEpisodeAnalytics | undefined>;
  previousRecoveryEpisodeAnalytics?(productId: string, marketplaceId: string, episodeId: string): Promise<RecoveryEpisodeAnalytics | undefined>;
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

  async recentByProductAndMarketplace(productId: string, marketplaceId: string, since: string): Promise<AutonomousFeedbackSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.productId === productId && snapshot.marketplaceId === marketplaceId && snapshot.observedAt >= since)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  }

  async recoveryEpisodeAnalytics(productId: string, marketplaceId: string, episodeId: string): Promise<RecoveryEpisodeAnalytics | undefined> {
    const snapshots = [...this.snapshots.values()].filter(s => s.productId === productId && s.marketplaceId === marketplaceId && s.recoveryEpisodeId === episodeId).sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.id.localeCompare(b.id));
    const start=snapshots[0]; if(!start) return undefined; const end=snapshots.find(s=>s.recoveryState==="recovered");
    return {episodeId,startedAt:start.observedAt,endedAt:end?.observedAt,durationMs:end?Math.max(0,Date.parse(end.observedAt)-Date.parse(start.observedAt)):undefined,snapshotCount:snapshots.length,recoveryClicks:end?.recoveryClicks??snapshots.at(-1)!.recoveryClicks,conversionDelta:(end??snapshots.at(-1)!).conversionCount-start.conversionCount,commissionDeltaCents:(end??snapshots.at(-1)!).attributedCommissionCents-start.attributedCommissionCents,averageQualityScore:snapshots.reduce((sum,s)=>sum+s.recoveryQualityScore,0)/snapshots.length,closingQualityScore:end?.recoveryQualityScore,closed:Boolean(end)};
  }

  async previousRecoveryEpisodeAnalytics(productId: string, marketplaceId: string, episodeId: string): Promise<RecoveryEpisodeAnalytics | undefined> {
    const episodes = [...new Set([...this.snapshots.values()].filter(s=>s.productId===productId&&s.marketplaceId===marketplaceId&&s.recoveryEpisodeId).map(s=>s.recoveryEpisodeId!))];
    const ids = episodes.filter(id=>id!==episodeId).sort();
    let previous: RecoveryEpisodeAnalytics|undefined;
    for (const id of ids) { const a=await this.recoveryEpisodeAnalytics(productId,marketplaceId,id); if(a && (!previous || a.startedAt>previous.startedAt)) previous=a; }
    return previous;
  }

  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.productId === productId && snapshot.marketplaceId === marketplaceId)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id))[0];
  }
}
