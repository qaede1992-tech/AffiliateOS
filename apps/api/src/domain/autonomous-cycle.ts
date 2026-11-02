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
    const productIds = candidateList.map((candidate) => candidate.product.id);
    // Never trust caller-supplied product IDs as proof of media rights.
    // Without the persisted media/rights repository, fail closed.
    const videoIds = this.productMediaDiscovery
      ? await this.productMediaDiscovery.listPublishableVideoProductIds(productIds)
      : [];
    const mediaIds = this.productMediaDiscovery
      ? await this.productMediaDiscovery.listPublishableMediaProductIds(productIds)
      : [];
    const finalPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: true, requirePublishableVideo: true, requireCommissionSignal: true }]));
    const result = await this.execution.previewSelection({
      ...input,
      candidates: candidateList,
      policiesByMarketplace: finalPolicies,
      requirePublishableMedia: true,
      requirePublishableVideo: true,
      publishableVideoProductIds: videoIds,
      publishableMediaProductIds: mediaIds,
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
      // Caller-supplied IDs are not evidence of publication rights.
      // If media discovery/storage is unavailable, the final media gates stay empty.
      let videoIds: string[] = [];
      let mediaIds: string[] = [];
      if (this.productMediaDiscovery) {
        // Pass 1: affiliate eligibility only. This pass never creates media or content.
        const preliminaryPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: false, requirePublishableVideo: false, requireCommissionSignal: true }]));
        const preliminary = await this.execution.previewSelection({
          ...input,
          idempotencyNamespace: input.idempotencyNamespace ?? "autonomous-execution",
          candidates: candidateList,
          policy: { ...input.policy, requirePublishableMedia: false, requirePublishableVideo: false, requireCommissionSignal: true },
          policiesByMarketplace: preliminaryPolicies,
          requirePublishableMedia: false,
          requirePublishableVideo: false,
          requireCommissionSignal: true
        });
        for (const selected of preliminary.selected) {
          const candidate = candidateList.find((item) => item.product.id === selected.product.id);
          if (!candidate) continue;
          try {
            await this.productMediaDiscovery.discover(candidate.product, true);
          } catch (error) {
            console.warn(JSON.stringify({
              event: "autonomous_product_media_discovery_failed",
              productId: candidate.product.id,
              reason: error instanceof Error ? error.message : "Product media discovery failed."
            }));
          }
        }

        const productIds = candidateList.map((candidate) => candidate.product.id);
        try {
          mediaIds = await this.productMediaDiscovery.listPublishableMediaProductIds(productIds);
        } catch (error) {
          mediaIds = [];
          console.warn(JSON.stringify({
            event: "autonomous_product_media_index_failed",
            reason: error instanceof Error ? error.message : "Product media index lookup failed."
          }));
        }
        try {
          // Keep readiness separate from publication rights: an unverified generated video
          // must not trigger endless rendering, but it must not pass the final publish gate.
          const storedVideoIds = await this.productMediaDiscovery.listVideoProductIds(productIds);
          videoIds = await this.productMediaDiscovery.listPublishableVideoProductIds(productIds);
          for (const id of storedVideoIds) {
            if (!videoIds.includes(id)) {
              console.info(JSON.stringify({ event: "autonomous_product_video_rights_unverified", productId: id }));
            }
          }
        } catch (error) {
          videoIds = [];
          console.warn(JSON.stringify({
            event: "autonomous_product_video_index_failed",
            reason: error instanceof Error ? error.message : "Product video index lookup failed."
          }));
        }

        // Pass 2: final affiliate selection. It requires verified, persisted product media,
        // but does not require a video yet. Only products selected here may incur video rendering.
        const mediaReadyPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: true, requirePublishableVideo: false, requireCommissionSignal: true }]));
        const mediaReady = await this.execution.previewSelection({
          ...input,
          idempotencyNamespace: input.idempotencyNamespace ?? "autonomous-execution",
          candidates: candidateList,
          policy: { ...input.policy, requirePublishableMedia: true, requirePublishableVideo: false, requireCommissionSignal: true },
          policiesByMarketplace: mediaReadyPolicies,
          requirePublishableMedia: true,
          requirePublishableVideo: false,
          publishableMediaProductIds: mediaIds,
          publishableVideoProductIds: videoIds,
          requireCommissionSignal: true
        });

        // Pass 3: generate promotional videos only for products that passed final affiliate selection.
        for (const selected of mediaReady.selected) {
          if (videoIds.includes(selected.product.id)) continue;
          const candidate = candidateList.find((item) => item.product.id === selected.product.id);
          if (!candidate) continue;
          try {
            const rendered = await this.productMediaDiscovery.generatePromoVideo(candidate.product);
            console.info(JSON.stringify({
              event: "autonomous_product_promo_video",
              productId: candidate.product.id,
              generated: rendered.generated,
              reason: rendered.reason
            }));
          } catch (error) {
            console.warn(JSON.stringify({
              event: "autonomous_product_promo_video_failed",
              productId: candidate.product.id,
              reason: error instanceof Error ? error.message : "Product promo video generation failed."
            }));
          }
        }
        try {
          videoIds = await this.productMediaDiscovery.listPublishableVideoProductIds(productIds);
        } catch (error) {
          videoIds = [];
          console.warn(JSON.stringify({
            event: "autonomous_product_video_index_failed",
            reason: error instanceof Error ? error.message : "Product video index lookup failed."
          }));
        }
      }
      const finalPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: true, requirePublishableVideo: true, requireCommissionSignal: true }]));
      const executionInput: AutonomousExecutionInput = {
        ...input,
        scheduledAt,
        candidates: candidateList,
        policiesByMarketplace: finalPolicies,
        requirePublishableMedia: true,
        requirePublishableVideo: true,
        publishableMediaProductIds: mediaIds,
        publishableVideoProductIds: videoIds,
        requireCommissionSignal: true
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
