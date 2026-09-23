import { randomUUID } from "node:crypto";
import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository } from "../domain/autonomous-decision-audit.js";
import { autonomousDecisionAudits } from "./schema.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AutonomousDecisionAuditAnalytics, AutonomousDecisionAuditQuery, AutonomousDecisionAuditReader, AutonomousDecisionOutcome } from "../domain/autonomous-decision-audit.js";

type DatabaseExecutor = any;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

export class DrizzleAutonomousDecisionAuditRepository implements AutonomousDecisionAuditRepository, AutonomousDecisionAuditReader {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(query: AutonomousDecisionAuditQuery = {}): Promise<AutonomousDecisionAudit[]> {
    const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
    const filters = [query.cycleId ? eq(autonomousDecisionAudits.cycleId, query.cycleId) : undefined, query.marketplaceId ? eq(autonomousDecisionAudits.marketplaceId, query.marketplaceId) : undefined, query.productId ? eq(autonomousDecisionAudits.productId, query.productId) : undefined, query.selected === undefined ? undefined : eq(autonomousDecisionAudits.selected, query.selected)].filter(Boolean) as any[];
    const rows = await this.db.select().from(autonomousDecisionAudits).where(filters.length ? and(...filters) : undefined).orderBy(desc(autonomousDecisionAudits.createdAt)).limit(limit);
    const campaignIds = rows.map((row: any) => row.outcomeCampaignId).filter((id: unknown): id is string => typeof id === "string");
    const analyticsByCampaign = new Map<string, AutonomousDecisionAuditAnalytics>();
    if (campaignIds.length) {
      const result = await this.db.execute(sql`
        SELECT
          campaigns.id AS campaign_id,
          (SELECT COUNT(*) FROM clicks cl JOIN tracking_links tl ON tl.id = cl.tracking_link_id WHERE tl.campaign_id = campaigns.id) AS click_count,
          (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_conversion_count,
          (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_revenue_cents,
          (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_commission_cents
        FROM campaigns
        WHERE campaigns.id IN (${sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      for (const row of rowsOf(result)) {
        const clickCount = Number(row.click_count ?? 0);
        const attributedConversionCount = Number(row.attributed_conversion_count ?? 0);
        analyticsByCampaign.set(String(row.campaign_id), {
          clickCount,
          attributedConversionCount,
          attributedRevenueCents: Number(row.attributed_revenue_cents ?? 0),
          attributedCommissionCents: Number(row.attributed_commission_cents ?? 0),
          conversionRate: clickCount === 0 ? 0 : attributedConversionCount / clickCount
        });
      }
    }
    return rows.map((row: any) => ({ cycleId: row.cycleId, auditId: row.id, productId: row.productId, marketplaceId: row.marketplaceId, selected: row.selected, selectionMode: row.selectionMode ?? undefined, score: row.score, policy: row.policy, reasons: row.reasons, category: row.category ?? undefined, audienceSegments: row.audienceSegments ?? undefined, performanceRegime: row.performanceRegime ?? undefined, createdAt: row.createdAt, outcome: row.outcomeStatus ? { offerId: row.outcomeOfferId ?? undefined, status: row.outcomeStatus, campaignId: row.outcomeCampaignId ?? undefined, error: row.outcomeError ?? undefined, observedAt: row.outcomeObservedAt, analytics: row.outcomeCampaignId ? analyticsByCampaign.get(row.outcomeCampaignId) : undefined, explorationEvaluation: row.explorationEvaluation ?? undefined } : undefined } : undefined }));
  }

  async saveMany(audits: AutonomousDecisionAudit[]): Promise<void> {
    if (!audits.length) return;
    await this.db.insert(autonomousDecisionAudits).values(audits.map((audit) => ({
      id: audit.auditId,
      cycleId: audit.cycleId,
      productId: audit.productId,
      marketplaceId: audit.marketplaceId,
      selected: audit.selected,
      selectionMode: audit.selectionMode ?? null,
      score: audit.score,
      policy: audit.policy,
      reasons: audit.reasons,
      category: audit.category ?? null,
      audienceSegments: audit.audienceSegments ?? null,
      createdAt: audit.createdAt
    })));
  }

  async updateExplorationEvaluation(auditId: string, evaluation: { status: string; reason: string; confidence: number }): Promise<void> {
    await this.db.update(autonomousDecisionAudits).set({ explorationEvaluation: evaluation }).where(eq(autonomousDecisionAudits.id, auditId));
  }

  async updateOutcome(auditId: string, outcome: AutonomousDecisionOutcome): Promise<void> {
    await this.db.update(autonomousDecisionAudits).set({
      outcomeOfferId: outcome.offerId ?? null,
      outcomeStatus: outcome.status,
      outcomeCampaignId: outcome.campaignId ?? null,
      outcomeError: outcome.error ?? null,
      outcomeObservedAt: outcome.observedAt,
      explorationEvaluation: outcome.explorationEvaluation ?? null
    }).where(eq(autonomousDecisionAudits.id, auditId));
  }
}
