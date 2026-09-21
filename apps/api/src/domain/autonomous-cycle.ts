import type { AudienceSegment, ContentPlatform } from "@affiliateos/shared";
import type { AutonomousExecutionCandidate, AutonomousExecutionInput, AutonomousExecutionResult, AutonomousExecutionService } from "./autonomous-execution.js";
import type { OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { CampaignAnalytics } from "./analytics.js";
import type { CampaignService } from "./campaigns.js";
import type { ContentService } from "./content.js";
import type { AutonomousOptimizationStateRepository } from "./autonomous-optimization-state.js";
import type { AutonomousCycleLockRepository } from "./autonomous-cycle-lock.js";
import { randomUUID } from "node:crypto";
import { OptimizationEngine, type OptimizationRecommendation, type OptimizationState } from "./optimization-engine.js";

export interface AutonomousCandidateProvider {
  listCandidates(): Promise<AutonomousExecutionCandidate[]>;
}

export type AutonomousCycleInput = Omit<AutonomousExecutionInput, "candidates"> & {
  policy?: OpportunitySelectionPolicy;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyNamespace?: string;
  publicationDelayMs?: number;
};

export type AutonomousCycleResult = {
  startedAt: string;
  completedAt: string;
  candidateCount: number;
  execution: AutonomousExecutionResult;
  optimization: OptimizationRecommendation[];
};

export class AutonomousCycleService {
  private running = false;
  private readonly optimizationState = new Map<string, OptimizationState>();
  private readonly lockOwnerId = randomUUID();
  private static readonly LOCK_LEASE_MS = 10 * 60_000;
  private static readonly LOCK_RENEW_MS = 2 * 60_000;

  constructor(
    private readonly candidates: AutonomousCandidateProvider,
    private readonly execution: AutonomousExecutionService,
    private readonly analytics?: { overview(): Promise<{ campaigns: CampaignAnalytics[] }> },
    private readonly optimizer: OptimizationEngine = new OptimizationEngine(),
    private readonly campaigns?: Pick<CampaignService, "update" | "get">,
    private readonly content?: Pick<ContentService, "list" | "createRevision">,
    private readonly optimizationStateRepository?: AutonomousOptimizationStateRepository,
    private readonly cycleLock?: AutonomousCycleLockRepository,
    private readonly cycleLockKey = "autonomous-cycle"
  ) {}

  async runOnce(input: AutonomousCycleInput = {}): Promise<AutonomousCycleResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const startedAt = new Date().toISOString();
    let lockAcquired = false;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    try {
      if (this.cycleLock) {
        const lockNow = startedAt;
        const leaseUntil = new Date(Date.parse(startedAt) + AutonomousCycleService.LOCK_LEASE_MS).toISOString();
        lockAcquired = await this.cycleLock.tryAcquire(this.cycleLockKey, this.lockOwnerId, lockNow, leaseUntil);
        if (!lockAcquired) return undefined;
        renewalTimer = setInterval(() => {
          const now = new Date();
          const nextLease = new Date(now.getTime() + AutonomousCycleService.LOCK_LEASE_MS).toISOString();
          void this.cycleLock!.renew(this.cycleLockKey, this.lockOwnerId, now.toISOString(), nextLease);
        }, AutonomousCycleService.LOCK_RENEW_MS);
      }
      const candidateList = await this.candidates.listCandidates();
      const scheduledAt = input.scheduledAt ?? (input.publicationDelayMs !== undefined
        ? new Date(Date.now() + input.publicationDelayMs).toISOString()
        : undefined);
      const executionInput: AutonomousExecutionInput = {
        ...input,
        scheduledAt,
        candidates: candidateList
      };
      const result = await this.execution.runOnce(executionInput);
      const analyticsOverview = this.analytics ? await this.analytics.overview() : undefined;
      const stateEntries = this.optimizationStateRepository && analyticsOverview ? await Promise.all(analyticsOverview.campaigns.map(async (campaign) => [campaign.campaignId, await this.optimizationStateRepository!.get(campaign.campaignId)] as const)) : [];
      for (const [campaignId, state] of stateEntries) if (state) this.optimizationState.set(campaignId, state);
      const optimization = analyticsOverview ? this.optimizer.recommend(analyticsOverview.campaigns, this.optimizationState) : [];
      if (this.campaigns) {
        for (const recommendation of optimization) {
          const campaign = await this.campaigns.get(recommendation.campaignId);
          if (recommendation.action !== "maintain") {
            const state = { action: recommendation.action, appliedAt: new Date().toISOString() };
            const previous = this.optimizationState.get(recommendation.campaignId);
            if (this.optimizationStateRepository?.compareAndSet) {
              const applied = await this.optimizationStateRepository.compareAndSet(recommendation.campaignId, previous?.appliedAt, state);
              if (!applied) {
                const current = await this.optimizationStateRepository.get(recommendation.campaignId);
                if (current) this.optimizationState.set(recommendation.campaignId, current);
                continue;
              }
            } else if (this.optimizationStateRepository) {
              await this.optimizationStateRepository.save(recommendation.campaignId, state);
            }
            this.optimizationState.set(recommendation.campaignId, state);
          }
          if (recommendation.action === "pause") {
            if (campaign.status !== "paused" && campaign.status !== "archived" && campaign.status !== "completed") {
              await this.campaigns.update(recommendation.campaignId, { status: "paused" });
            }
          } else if (recommendation.action === "scale") {
            if (campaign.status !== "active") await this.campaigns.update(recommendation.campaignId, { status: "active" });
          } else if (recommendation.action === "revise-content" && this.content) {
            if (campaign.status === "paused" || campaign.status === "archived" || campaign.status === "completed") continue;
            const existing = await this.content.list(recommendation.campaignId);
            const source = existing.find((item) => item.status === "published" || item.status === "scheduled");
            if (source) await this.content.createRevision(recommendation.campaignId, source);
          }
        }
      }
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        candidateCount: candidateList.length,
        execution: result,
        optimization
      };
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      if (lockAcquired && this.cycleLock) await this.cycleLock.release(this.cycleLockKey, this.lockOwnerId);
      this.running = false;
    }
  }
}
