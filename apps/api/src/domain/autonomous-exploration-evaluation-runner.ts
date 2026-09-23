import { evaluateExploration, type ExplorationEvaluationPolicy } from "./exploration-evaluator.js";
import type { AutonomousDecisionAuditReader, AutonomousDecisionAuditRepository } from "./autonomous-decision-audit.js";

export type ExplorationEvaluationRunResult = {
  evaluated: number;
  skipped: number;
  failed: number;
};

export class AutonomousExplorationEvaluationRunner {
  constructor(
    private readonly reader: AutonomousDecisionAuditReader,
    private readonly repository: AutonomousDecisionAuditRepository,
    private readonly policy: ExplorationEvaluationPolicy = {}
  ) {}

  async run(): Promise<ExplorationEvaluationRunResult> {
    const audits = await this.reader.list({ selected: true, limit: 500 });
    let evaluated = 0;
    let skipped = 0;
    let failed = 0;
    for (const audit of audits) {
      if (audit.selectionMode !== "exploration" || !audit.outcome?.analytics || audit.outcome.explorationEvaluation) {
        skipped += 1;
        continue;
      }
      const evaluation = evaluateExploration(audit, this.policy);
      if (!evaluation || !this.repository.updateExplorationEvaluation) {
        skipped += 1;
        continue;
      }
      try {
        await this.repository.updateExplorationEvaluation(audit.auditId, evaluation);
        evaluated += 1;
      } catch {
        failed += 1;
      }
    }
    return { evaluated, skipped, failed };
  }
}
