import { randomUUID } from "node:crypto";
import type { AudienceSegment, ContentPlatform } from "@affiliateos/shared";
import type { AutonomousExecutionCandidate, AutonomousExecutionInput, AutonomousExecutionResult, AutonomousExecutionService } from "./autonomous-execution.js";
export type { AutonomousExecutionCandidate } from "./autonomous-execution.js";
import type { OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { AutonomousOptimizationRunResult, AutonomousOptimizationRunner } from "./autonomous-optimization-runner.js";
import type { AutonomousExplorationEvaluationRunner, ExplorationEvaluationRunResult } from "./autonomous-exploration-evaluation-runner.js";
import { InMemoryAutonomousCycleLock, type AutonomousCycleLock } from "./autonomous-cycle-lock.js";
import type { ProductMediaDiscoveryRunner } from "./product-media-discovery-runner.js";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import { MEDIA_READINESS_MAX_CONFIDENCE_LIFT, MEDIA_READINESS_MAX_SCORE_LIFT } from "./opportunity-scoring.js";

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

export type AutonomousCycleSkipReason = "already_running" | "lock_busy" | "no_runnable_candidates" | "no_publishable_candidates";

const safeErrorType = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";

const classifyMediaSkipReason = (reason: string): string => {
  const normalized = reason.toLowerCase();
  if (normalized.includes("shopee product-page media extraction is disabled")) return "shopee_catalog_media_missing";
  if (normalized.includes("no public video candidate")) return "no_public_video_candidate";
  if (normalized.includes("response is not html")) return "product_page_not_html";
  if (normalized.includes("https") && (normalized.includes("invalid") || normalized.includes("credential"))) return "invalid_media_url";
  if (normalized.includes("timeout")) return "media_fetch_timeout";
  if (normalized.includes("blocked") || normalized.includes("private network")) return "media_fetch_blocked";
  return "other";
};

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
    private readonly productMediaDiscovery?: ProductMediaDiscoveryRunner,
    private readonly preMediaEligibility?: PreMediaEligibilityRepository
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
    const mediaReadinessScores = this.productMediaDiscovery
      ? await this.productMediaDiscovery.listMediaReadinessScores(productIds, input.platforms)
      : Object.fromEntries(productIds.map((id) => [id, 0]));
    const finalPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [key, { ...value, requirePublishableMedia: true, requirePublishableVideo: true, requireCommissionSignal: true }]));
    const result = await this.execution.previewSelection({
      ...input,
      candidates: candidateList,
      policiesByMarketplace: finalPolicies,
      requirePublishableMedia: true,
      requirePublishableVideo: true,
      publishableVideoProductIds: videoIds,
      publishableMediaProductIds: mediaIds,
      mediaReadinessScores,
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

      // An empty catalog is not autonomous work. Avoid media discovery, execution,
      // exploration, optimization analytics, and feedback-history reads entirely.
      const runnableCandidateCount = candidateList.filter((candidate) => candidate.offers.length > 0).length;
      if (runnableCandidateCount === 0) {
        this.lastSkipReason = "no_runnable_candidates";
        console.info(JSON.stringify({
          event: "autonomous_cycle_skipped",
          reason: "no_runnable_candidates",
          catalogCandidateCount: candidateList.length
        }));
        const completedAt = new Date().toISOString();
        return {
          startedAt,
          completedAt,
          candidateCount: candidateList.length,
          execution: { selected: [], rejected: [], audit: [], outcomes: [], recoveredRunCount: 0 }
        };
      }
      // Caller-supplied IDs are not evidence of publication rights.
      // If media discovery/storage is unavailable, the final media gates stay empty.
      let videoIds: string[] = [];
      let mediaIds: string[] = [];
      let mediaReadinessScores: Record<string, number> = Object.fromEntries(candidateList.map((candidate) => [candidate.product.id, 0]));
      if (this.productMediaDiscovery) {
        // Pass 1: discover media for candidates that could still reach the final score
        // after the 10%-weighted media signal is known. The score baseline is 50, so
        // verified media can lift a preliminary score by at most five points. This
        // discovery-only buffer never lowers the final selection threshold.
        const defaultMinimumScore = input.policy?.minimumScore ?? 60;
        const defaultMinimumDataConfidence = input.policy?.minimumDataConfidence ?? 35;
        const preliminaryMinimumScore = Math.max(0, defaultMinimumScore - MEDIA_READINESS_MAX_SCORE_LIFT);
        const preliminaryMinimumDataConfidence = Math.max(0, defaultMinimumDataConfidence - MEDIA_READINESS_MAX_CONFIDENCE_LIFT);
        const preliminaryPolicies = Object.fromEntries(Object.entries(input.policiesByMarketplace ?? {}).map(([key, value]) => [
          key,
          {
            ...value,
            minimumScore: Math.max(0, (value.minimumScore ?? defaultMinimumScore) - MEDIA_READINESS_MAX_SCORE_LIFT),
            minimumDataConfidence: Math.max(0, (value.minimumDataConfidence ?? defaultMinimumDataConfidence) - MEDIA_READINESS_MAX_CONFIDENCE_LIFT),
            requirePublishableMedia: false,
            requirePublishableVideo: false,
            requireCommissionSignal: true
          }
        ]));
        const preliminary = await this.execution.previewSelection({
          ...input,
          idempotencyNamespace: input.idempotencyNamespace ?? "autonomous-execution",
          feedbackHistoryMode: "latest",
          candidates: candidateList,
          policy: { ...input.policy, minimumScore: preliminaryMinimumScore, minimumDataConfidence: preliminaryMinimumDataConfidence, requirePublishableMedia: false, requirePublishableVideo: false, requireCommissionSignal: true },
          policiesByMarketplace: preliminaryPolicies,
          requirePublishableMedia: false,
          requirePublishableVideo: false,
          requireCommissionSignal: true
        });
        if (this.preMediaEligibility && preliminary.audit.length) {
          const evidenceCreatedAt = new Date().toISOString();
          const evidenceCycleId = randomUUID();
          const selectedByProduct = new Map(preliminary.selected.map((selected) => [selected.product.id, selected]));
          const evidence = preliminary.audit.map((decision) => {
            const selected = selectedByProduct.get(decision.productId);
            return {
              id: randomUUID(),
              cycleId: evidenceCycleId,
              productId: decision.productId,
              marketplaceId: decision.marketplaceId,
              offerId: selected?.offerId,
              eligible: decision.selected,
              score: decision.score,
              policy: {
                ...(input.policy ?? {}),
                ...decision.policy,
                minimumScore: decision.policy.minimumScore ?? preliminaryMinimumScore,
                minimumDataConfidence: decision.policy.minimumDataConfidence ?? preliminaryMinimumDataConfidence,
                requirePublishableMedia: false,
                requirePublishableVideo: false,
                requireCommissionSignal: true
              },
              reasons: decision.reasons ?? [],
              createdAt: evidenceCreatedAt
            };
          });
          try {
            await this.preMediaEligibility.saveMany(evidence);
          } catch (error) {
            // Database/ORM errors may embed the full SQL statement and bound values.
            // Keep operational logs useful without leaking query parameters or product data.
            console.warn(JSON.stringify({
              event: "autonomous_pre_media_eligibility_persist_failed",
              evidenceCount: evidence.length,
              errorType: safeErrorType(error)
            }));
            // The evidence is the audit record that authorizes the later admin-reviewed
            // media-import workflow. Do not continue selection/discovery without it.
            throw new Error("Pre-media eligibility evidence could not be persisted; autonomous cycle aborted.");
          }
        }
        const mediaDiscoverySummary = {
          attemptedCount: 0,
          failedCount: 0,
          storedImageCount: 0,
          storedVideoCount: 0,
          skippedReasonCounts: {} as Record<string, number>,
          catalogCandidateCount: 0
        };
        for (const selected of preliminary.selected) {
          const candidate = candidateList.find((item) => item.product.id === selected.product.id);
          if (!candidate) continue;
          try {
            const discovery = await this.productMediaDiscovery.discover(candidate.product, true);
            mediaDiscoverySummary.attemptedCount += 1;
            mediaDiscoverySummary.catalogCandidateCount += discovery.candidatesFound ?? 0;
            for (const asset of discovery.stored) {
              if (asset.kind === "image") mediaDiscoverySummary.storedImageCount += 1;
              if (asset.kind === "video") mediaDiscoverySummary.storedVideoCount += 1;
            }
            for (const skipped of discovery.skipped) {
              const reasonCode = classifyMediaSkipReason(skipped.reason);
              mediaDiscoverySummary.skippedReasonCounts[reasonCode] = (mediaDiscoverySummary.skippedReasonCounts[reasonCode] ?? 0) + 1;
            }
          } catch (error) {
            mediaDiscoverySummary.failedCount += 1;
            console.warn(JSON.stringify({
              event: "autonomous_product_media_discovery_failed",
              productId: candidate.product.id,
              errorType: safeErrorType(error)
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
            errorType: safeErrorType(error)
          }));
        }
        if (mediaIds.length === 0) {
          console.info(JSON.stringify({
            event: "autonomous_media_discovery_summary",
            candidateCount: candidateList.length,
            preliminaryMinimumScore,
            finalMinimumScore: defaultMinimumScore,
            preliminaryMinimumDataConfidence,
            finalMinimumDataConfidence: defaultMinimumDataConfidence,
            preliminarySelectedCount: preliminary.selected.length,
            discoveryAttemptedCount: mediaDiscoverySummary.attemptedCount,
            discoveryFailedCount: mediaDiscoverySummary.failedCount,
            catalogCandidateCount: mediaDiscoverySummary.catalogCandidateCount,
            storedImageCount: mediaDiscoverySummary.storedImageCount,
            storedVideoCount: mediaDiscoverySummary.storedVideoCount,
            skippedReasonCounts: mediaDiscoverySummary.skippedReasonCounts,
            mediaReadySelectedCount: 0,
            mediaReadyRejectedCount: candidateList.length,
            publishableMediaProductCount: 0,
            publishableVideoProductCount: 0
          }));
          this.lastSkipReason = "no_publishable_candidates";
          console.info(JSON.stringify({
            event: "autonomous_cycle_skipped",
            reason: "no_publishable_candidates",
            catalogCandidateCount: candidateList.length
          }));
          return {
            startedAt,
            completedAt: new Date().toISOString(),
            candidateCount: candidateList.length,
            execution: { selected: [], rejected: [], audit: [], outcomes: [], recoveredRunCount: 0 }
          };
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
            errorType: safeErrorType(error)
          }));
        }

        try {
          mediaReadinessScores = await this.productMediaDiscovery.listMediaReadinessScores(productIds, input.platforms);
        } catch (error) {
          mediaReadinessScores = Object.fromEntries(productIds.map((id) => [id, 0]));
          console.warn(JSON.stringify({ event: "autonomous_product_media_readiness_failed", errorType: safeErrorType(error) }));
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
          mediaReadinessScores,
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
              errorType: safeErrorType(error)
            }));
          }
        }
        try {
          videoIds = await this.productMediaDiscovery.listPublishableVideoProductIds(productIds);
        } catch (error) {
          videoIds = [];
          console.warn(JSON.stringify({
            event: "autonomous_product_video_index_failed",
            errorType: safeErrorType(error)
          }));
        }
        console.info(JSON.stringify({
          event: "autonomous_media_discovery_summary",
          candidateCount: candidateList.length,
          preliminaryMinimumScore,
          finalMinimumScore: defaultMinimumScore,
          preliminaryMinimumDataConfidence,
          finalMinimumDataConfidence: defaultMinimumDataConfidence,
          preliminarySelectedCount: preliminary.selected.length,
          discoveryAttemptedCount: mediaDiscoverySummary.attemptedCount,
          discoveryFailedCount: mediaDiscoverySummary.failedCount,
          catalogCandidateCount: mediaDiscoverySummary.catalogCandidateCount,
          storedImageCount: mediaDiscoverySummary.storedImageCount,
          storedVideoCount: mediaDiscoverySummary.storedVideoCount,
          skippedReasonCounts: mediaDiscoverySummary.skippedReasonCounts,
          mediaReadySelectedCount: mediaReady.selected.length,
          mediaReadyRejectedCount: mediaReady.rejected.length,
          publishableMediaProductCount: mediaIds.length,
          publishableVideoProductCount: videoIds.length
        }));
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
        mediaReadinessScores,
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
