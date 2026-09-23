import { randomUUID } from "node:crypto";
import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository } from "../domain/autonomous-decision-audit.js";
import { autonomousDecisionAudits } from "./schema.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AutonomousDecisionAuditAnalytics, AutonomousDecisionAuditQuery, AutonomousDecisionAuditReader } from "../domain/autonomous-decision-audit.js";

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
          tl.campaign_id,
          COUNT(DISTINCT cl.id) AS click_count,
          COUNT(DISTINCT CASE WHEN cv.status <> 'rejected' THEN cv.id END) AS attributed_conversion_count,
          COALESCE(SUM(CASE WHEN cv.status <> 'rejected' THEN cv.amount_cents ELSE 0 END), 0) AS attributed_revenue_cents,
          COALESCE(SUM(CASE WHEN cv.status <> 'rejected' THEN cm.amount_cents ELSE 0 END), 0) AS attributed_commission_cents
        FROM tracking_links tl
        LEFT JOIN clicks cl ON cl.tracking_link_id = tl.id
        LEFT JOIN conversion_attributions ca ON ca.tracking_link_id = tl.id
        LEFT JOIN conversions cv ON cv.id = ca.conversion_id
        LEFT JOIN commissions cm ON cm.conversion_id = cv.id
        WHERE tl.campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)})
        GROUP BY tl.campaign_id
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
    return rows.map((row: any) => ({ cycleId: row.cycleId, auditId: row.id, productId: row.productId, marketplaceId: row.marketplaceId, selected: row.selected, score: row.score, policy: row.policy, reasons: row.reasons, createdAt: row.createdAt, outcome: row.outcomeStatus ? { offerId: row.outcomeOfferId ?? undefined, status: row.outcomeStatus, campaignId: row.outcomeCampaignId ?? undefined, error: row.outcomeError ?? undefined, observedAt: row.outcomeObservedAt, analytics: row.outcomeCampaignId ? analyticsByCampaign.get(row.outcomeCampaignId) : undefined } : undefined }));
  }

  async saveMany(audits: AutonomousDecisionAudit[]): Promise<void> {
    if (!audits.length) return;
    await this.db.insert(autonomousDecisionAudits).values(audits.map((audit) => ({
      id: audit.auditId,
      cycleId: audit.cycleId,
      productId: audit.productId,
      marketplaceId: audit.marketplaceId,
      selected: audit.selected,
      score: audit.score,
      policy: audit.policy,
      reasons: audit.reasons,
      createdAt: audit.createdAt
    })));
  }

  async updateOutcome(auditId: string, outcome: { offerId?: string; status: "completed" | "failed"; campaignId?: string; error?: string; observedAt: string }): Promise<void> {
    await this.db.update(autonomousDecisionAudits).set({
      outcomeOfferId: outcome.offerId ?? null,
      outcomeStatus: outcome.status,
      outcomeCampaignId: outcome.campaignId ?? null,
      outcomeError: outcome.error ?? null,
      outcomeObservedAt: outcome.observedAt
    }).where(eq(autonomousDecisionAudits.id, auditId));
  }
}
