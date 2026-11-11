import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository, AutonomousDecisionAuditQuery, AutonomousDecisionAuditReader, AutonomousDecisionOutcome, AutonomousDecisionOutcomeAnalytics } from "../domain/autonomous-decision-audit.js";
import { autonomousDecisionAudits } from "./schema.js";
import { and, desc, eq, sql } from "drizzle-orm";

type DatabaseExecutor = any;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Compare only persisted decision fields; cycle/id/time are intentionally excluded. */
export function hasSameDecisionSnapshot(
  audit: AutonomousDecisionAudit,
  previous: Record<string, unknown>
): boolean {
  return previous.selected === false
    && Number(previous.score) === audit.score
    && (previous.selectionMode ?? null) === (audit.selectionMode ?? null)
    && (previous.category ?? null) === (audit.category ?? null)
    && stableJson(previous.policy) === stableJson(audit.policy)
    && stableJson(previous.reasons) === stableJson(audit.reasons)
    && stableJson(previous.audienceSegments) === stableJson(audit.audienceSegments)
    && stableJson(previous.recovery) === stableJson(audit.recovery);
}

export class DrizzleAutonomousDecisionAuditRepository implements AutonomousDecisionAuditRepository, AutonomousDecisionAuditReader {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(query: AutonomousDecisionAuditQuery = {}): Promise<AutonomousDecisionAudit[]> {
    const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
    const filters = [
      query.cycleId ? eq(autonomousDecisionAudits.cycleId, query.cycleId) : undefined,
      query.marketplaceId ? eq(autonomousDecisionAudits.marketplaceId, query.marketplaceId) : undefined,
      query.productId ? eq(autonomousDecisionAudits.productId, query.productId) : undefined,
      query.recoveryEpisodeId ? sql`${autonomousDecisionAudits.recovery}->>'recoveryEpisodeId' = ${query.recoveryEpisodeId}` : undefined,
      query.selected === undefined ? undefined : eq(autonomousDecisionAudits.selected, query.selected)
    ].filter(Boolean) as any[];

    const rows = await this.db.select().from(autonomousDecisionAudits)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(autonomousDecisionAudits.createdAt))
      .limit(limit);

    const campaignIds = rows.map((row: any) => row.outcomeCampaignId)
      .filter((id: unknown): id is string => typeof id === "string");
    const analyticsByCampaign = new Map<string, AutonomousDecisionOutcomeAnalytics>();

    if (campaignIds.length) {
      const result = await this.db.execute(sql`
        SELECT
          campaigns.id AS campaign_id,
          (SELECT COUNT(*) FROM clicks cl JOIN tracking_links tl ON tl.id = cl.tracking_link_id WHERE tl.campaign_id = campaigns.id) AS click_count,
          (SELECT COUNT(*) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_conversion_count,
          (SELECT COALESCE(SUM(cv.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_revenue_cents,
          (SELECT COALESCE(SUM(cm.amount_cents), 0) FROM conversion_attributions ca JOIN conversions cv ON cv.id = ca.conversion_id JOIN commissions cm ON cm.conversion_id = cv.id JOIN tracking_links tl ON tl.id = ca.tracking_link_id WHERE tl.campaign_id = campaigns.id AND cv.status <> 'rejected') AS attributed_commission_cents
        FROM campaigns
        WHERE campaigns.id IN (${sql.join(campaignIds.map((id: string) => sql`${id}::uuid`), sql`, `)})
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

    return rows.map((row: any) => ({
      cycleId: row.cycleId,
      auditId: row.id,
      productId: row.productId,
      marketplaceId: row.marketplaceId,
      selected: row.selected,
      selectionMode: row.selectionMode ?? undefined,
      score: row.score,
      policy: row.policy,
      reasons: row.reasons,
      category: row.category ?? undefined,
      audienceSegments: row.audienceSegments ?? undefined,
      createdAt: row.createdAt,
      recovery: row.recovery ?? undefined,
      outcome: row.outcomeStatus
        ? {
            offerId: row.outcomeOfferId ?? undefined,
            status: row.outcomeStatus,
            campaignId: row.outcomeCampaignId ?? undefined,
            error: row.outcomeError ?? undefined,
            observedAt: row.outcomeObservedAt,
            analytics: row.outcomeCampaignId ? analyticsByCampaign.get(row.outcomeCampaignId) : undefined,
            explorationEvaluation: row.explorationEvaluation ?? undefined
          }
        : undefined
    }));
  }

  async saveMany(audits: AutonomousDecisionAudit[]): Promise<void> {
    if (!audits.length) return;

    // Rejected decisions are often re-evaluated unchanged across many work events.
    // Keep the latest distinct decision state instead of inserting an identical row
    // for every cycle. Selected decisions are always persisted because their outcome
    // and exploration evaluation are attached to the new audit ID.
    const rejected = audits.filter((audit) => !audit.selected);
    const previousByPair = new Map<string, Record<string, unknown>>();
    if (rejected.length) {
      const pairs = [...new Map(rejected.map((audit) => [
        `${audit.productId}:${audit.marketplaceId}`,
        [audit.productId, audit.marketplaceId] as const
      ])).values()];
      const result = await this.db.execute(sql`
        SELECT DISTINCT ON (product_id, marketplace_id)
          id AS "auditId",
          product_id AS "productId",
          marketplace_id AS "marketplaceId",
          selected,
          selection_mode AS "selectionMode",
          score,
          policy,
          reasons,
          category,
          audience_segments AS "audienceSegments",
          recovery
        FROM autonomous_decision_audits
        WHERE (product_id, marketplace_id) IN (${sql.join(
          pairs.map(([productId, marketplaceId]) => sql`(${productId}::uuid, ${marketplaceId}::uuid)`),
          sql`, `
        )})
        ORDER BY product_id, marketplace_id, created_at DESC
      `);
      for (const row of rowsOf(result)) {
        previousByPair.set(`${String(row.productId)}:${String(row.marketplaceId)}`, row);
      }
    }

    const changedAudits = audits.filter((audit) => {
      if (audit.selected) return true;
      const previous = previousByPair.get(`${audit.productId}:${audit.marketplaceId}`);
      return !previous || !hasSameDecisionSnapshot(audit, previous);
    });
    if (!changedAudits.length) return;

    await this.db.insert(autonomousDecisionAudits).values(changedAudits.map((audit) => ({
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
      recovery: audit.recovery ?? null,
      createdAt: audit.createdAt
    })));
  }

  async updateExplorationEvaluation(auditId: string, evaluation: { status: string; reason: string; confidence: number }): Promise<void> {
    await this.db.update(autonomousDecisionAudits).set({ explorationEvaluation: evaluation })
      .where(eq(autonomousDecisionAudits.id, auditId));
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
