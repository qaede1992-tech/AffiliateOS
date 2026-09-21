import type { AudienceSegment, ContentPlatform } from "@affiliateos/shared";
import type { AutonomousExecutionCandidate, AutonomousExecutionInput, AutonomousExecutionResult, AutonomousExecutionService } from "./autonomous-execution.js";
import type { OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { CampaignAnalytics } from "./analytics.js";
import type { CampaignService } from "./campaigns.js";
import type { ContentService } from "./content.js";
import { OptimizationEngine, type OptimizationRecommendation } from "./optimization-engine.js";

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

  constructor(
    private readonly candidates: AutonomousCandidateProvider,
    private readonly execution: AutonomousExecutionService,
    private readonly analytics?: { overview(): Promise<{ campaigns: CampaignAnalytics[] }> },
    private readonly optimizer: OptimizationEngine = new OptimizationEngine(),
    private readonly campaigns?: Pick<CampaignService, "update" | "get">,
    private readonly content?: Pick<ContentService, "list" | "createRevision">
  ) {}

  async runOnce(input: AutonomousCycleInput = {}): Promise<AutonomousCycleResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const startedAt = new Date().toISOString();

    try {
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
      const optimization = this.analytics ? this.optimizer.recommend((await this.analytics.overview()).campaigns) : [];
      if (this.campaigns) {
        for (const recommendation of optimization) {
          const campaign = await this.campaigns.get(recommendation.campaignId);
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
      this.running = false;
    }
  }
}
