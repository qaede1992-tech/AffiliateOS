import type { AudienceSegment, ContentPlatform } from "@affiliateos/shared";
import type { AutonomousExecutionCandidate, AutonomousExecutionInput, AutonomousExecutionResult, AutonomousExecutionService } from "./autonomous-execution.js";
export type { AutonomousExecutionCandidate } from "./autonomous-execution.js";
import type { OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { AutonomousOptimizationRunResult, AutonomousOptimizationRunner } from "./autonomous-optimization-runner.js";
import type { AutonomousExplorationEvaluationRunner, ExplorationEvaluationRunResult } from "./autonomous-exploration-evaluation-runner.js";
import { InMemoryAutonomousCycleLock, type AutonomousCycleLock } from "./autonomous-cycle-lock.js";
import type { ProductMediaDiscoveryRunner } from "./product-media-discovery-runner.js";

export interface AutonomousCandidateProvider {
  listCandidates(options?: { resolveAffiliateLinks?: boolean }): Promise<AutonomousExecutionCandidate[]>;
}

export type AutonomousCycleInput = Omit<AutonomousExecutionInput, "candidates"> & {
  policy?: OpportunitySelectionPolicy;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyNamespace?: string;
  /** Delay, in milliseconds, used to derive scheduledAt when it is not supplied explicitly. */
  publicationDelayMs?: number;
};

export type AutonomousCycleResult = {
  startedAt: string;
  completedAt: string;
  candidateCount: number;
  execution: AutonomousExecutionResult;
  optimization?: AutonomousOptimizationRunResult;
  explorationEvaluation?: ExplorationEvaluationRunResult;
};

export type AutonomousCycleSkipReason = "already_running" | "lock_busy";

export class AutonomousCycleService {
  private running = false;
  private lastSkipReason?: AutonomousCycleSkipReason;
  private readonly lock: AutonomousCycleLock;

  constructor(
    private readonly candidates: AutonomousCandidateProvider,
    private readonly execution: AutonomousExecutionService,
    lock?: AutonomousCycleLock,
    private readonly lockKey = "affiliateos:autonomous-cycle",
    private readonly optimization?: AutonomousOptimizationRunner,
    private readonly explorationEvaluation?: AutonomousExplorationEvaluationRunner,
    private readonly productMediaDiscovery?: ProductMediaDiscoveryRunner
  ) {
    this.lock = lock ?? new InMemoryAutonomousCycleLock();
  }

  get skipReason(): AutonomousCycleSkipReason | undefined {
    return this.lastSkipReason;
  }

  async previewSelection(input: AutonomousCycleInput = {}): Promise<{
    candidateCount: number;
    selected: AutonomousExecutionResult["selected"];
    rejected: AutonomousExecutionResult["rejected"];
    audit: AutonomousExecutionResult["audit"];
  }> {
    const candidateList = await this.candidates.listCandidates({ resolveAffiliateLinks: false });
    const videoIds = this.productMediaDiscovery
      ? await this.productMediaDiscovery.listVideoProductIds(candidateList.map((candidate) => candidate.product.id))
      : input.publishableVideoProductIds ?? [];
    const result = await this.execution.previewSelection({
      ...input,
      candidates: candidateList,
      requirePublishableMedia: true,
      requirePublishableVideo: true,
      publishableVideoProductIds: videoIds,
      requireCommissionSignal: true
    });
    return {
      candidateCount: candidateList.length,
      ...result
    };
  }

  async runOnce(input: AutonomousCycleInput = {}): Promise<AutonomousCycleResult | undefined> {
    this.lastSkipReason = undefined;
    if (this.running) {
      this.lastSkipReason = "already_running";
      return undefined;
    }
    if (!(await this.lock.tryAcquire(this.lockKey))) {
      this.lastSkipReason = "lock_busy";
      return undefined;
    }
    this.running = true;
    const startedAt = new Date().toISOString();

    try {
      const candidateList = await this.candidates.listCandidates({ resolveAffiliateLinks: true });
      const publicationEnabled = input.publicationEnabled ?? true;
      const scheduledAt = publicationEnabled ? (input.scheduledAt ?? this.deriveScheduledAt(input.publicationDelayMs)) : undefined;
      let videoIds = input.publishableVideoProductIds ?? [];
      if (this.productMediaDiscovery) {
        // First pass preserves every non-media threshold but does not reject products solely because
        // media has not yet been discovered. It never creates campaigns or content.
        const preliminaryPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: false, requirePublishableVideo: false }]));
        const preliminary = await this.execution.previewSelection({
          ...input, candidates: candidateList, policy: { ...input.policy, requirePublishableMedia: false, requirePublishableVideo: false },
          policiesByMarketplace: preliminaryPolicies, requirePublishableMedia: false, requirePublishableVideo: false, requireCommissionSignal: true
        });
        for (const selected of preliminary.selected) {
          const candidate = candidateList.find((item) => item.product.id === selected.product.id);
          if (candidate) await this.productMediaDiscovery.discover(candidate.product, true);
        }
        videoIds = await this.productMediaDiscovery.listVideoProductIds(candidateList.map((candidate) => candidate.product.id));
      }
      const executionInput: AutonomousExecutionInput = {
        ...input, scheduledAt, candidates: candidateList, requirePublishableMedia: true,
        requirePublishableVideo: true, publishableVideoProductIds: videoIds, requireCommissionSignal: true
      };
      const result = await this.execution.runOnce(executionInput);
      const explorationEvaluation = this.explorationEvaluation ? await this.explorationEvaluation.run() : undefined;
      const optimization = this.optimization ? await this.optimization.run(new Date(), { allowMutations: publicationEnabled }) : undefined;
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        candidateCount: candidateList.length,
        execution: result,
        optimization,
        explorationEvaluation
      };
    } finally {
      this.running = false;
      await this.lock.release(this.lockKey);
    }
  }

  private deriveScheduledAt(publicationDelayMs: number | undefined): string | undefined {
    const effectiveDelayMs = publicationDelayMs ?? 0;
    if (!Number.isFinite(effectiveDelayMs) || effectiveDelayMs < 0) {
      throw new Error("publicationDelayMs must be a finite non-negative number");
    }
    return new Date(Date.now() + effectiveDelayMs).toISOString();
  }
}
