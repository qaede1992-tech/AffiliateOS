import type { AudienceSegment, ContentPlatform } from "@affiliateos/shared";
import type { AutonomousExecutionCandidate, AutonomousExecutionInput, AutonomousExecutionResult, AutonomousExecutionService } from "./autonomous-execution.js";
export type { AutonomousExecutionCandidate } from "./autonomous-execution.js";
import type { OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { AutonomousOptimizationRunResult, AutonomousOptimizationRunner } from "./autonomous-optimization-runner.js";
import type { AutonomousExplorationEvaluationRunner, ExplorationEvaluationRunResult } from "./autonomous-exploration-evaluation-runner.js";
import { InMemoryAutonomousCycleLock, type AutonomousCycleLock } from "./autonomous-cycle-lock.js";

export interface AutonomousCandidateProvider {
  listCandidates(): Promise<AutonomousExecutionCandidate[]>;
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

export class AutonomousCycleService {
  private running = false;
  private readonly lock: AutonomousCycleLock;

  constructor(
    private readonly candidates: AutonomousCandidateProvider,
    private readonly execution: AutonomousExecutionService,
    lock?: AutonomousCycleLock,
    private readonly lockKey = "affiliateos:autonomous-cycle",
    private readonly optimization?: AutonomousOptimizationRunner,
    private readonly explorationEvaluation?: AutonomousExplorationEvaluationRunner
  ) {
    this.lock = lock ?? new InMemoryAutonomousCycleLock();
  }

  async runOnce(input: AutonomousCycleInput = {}): Promise<AutonomousCycleResult | undefined> {
    if (this.running) return undefined;
    if (!(await this.lock.tryAcquire(this.lockKey))) return undefined;
    this.running = true;
    const startedAt = new Date().toISOString();

    try {
      const candidateList = await this.candidates.listCandidates();
      const scheduledAt = input.scheduledAt ?? this.deriveScheduledAt(input.publicationDelayMs);
      const executionInput: AutonomousExecutionInput = {
        ...input,
        scheduledAt,
        candidates: candidateList
      };
      const result = await this.execution.runOnce(executionInput);
      const explorationEvaluation = this.explorationEvaluation ? await this.explorationEvaluation.run() : undefined;
      const optimization = this.optimization ? await this.optimization.run(new Date()) : undefined;
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
    if (publicationDelayMs === undefined) return undefined;
    if (!Number.isFinite(publicationDelayMs) || publicationDelayMs < 0) {
      throw new Error("publicationDelayMs must be a finite non-negative number");
    }
    return new Date(Date.now() + publicationDelayMs).toISOString();
  }
}
