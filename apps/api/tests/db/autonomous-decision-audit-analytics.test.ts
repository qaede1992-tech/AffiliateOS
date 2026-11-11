import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleAutonomousDecisionAuditRepository } from "../../src/db/autonomous-decision-audit-repository.js";

test("decision audit analytics aggregate metrics by campaign instead of correlated per-campaign scans", async () => {
  let compiled: { sql: string; params: unknown[] } | undefined;
  const auditRow = {
    id: "audit-1", cycleId: "cycle-1", productId: "product-1", marketplaceId: "marketplace-1",
    selected: true, selectionMode: "standard", score: 90, policy: {}, reasons: [],
    category: "home", audienceSegments: [], createdAt: "2026-11-11T00:00:00.000Z",
    recovery: null, outcomeOfferId: "offer-1", outcomeStatus: "completed",
    outcomeCampaignId: "00000000-0000-4000-8000-000000000123", outcomeError: null,
    outcomeObservedAt: "2026-11-11T00:01:00.000Z", explorationEvaluation: null
  };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [auditRow] }) }) }) }),
    execute: async (query: { toQuery: (config: { escapeName: (name: string) => string; escapeParam: (index: number) => string; escapeString: (value: string) => string }) => { sql: string; params: unknown[] } }) => {
      compiled = query.toQuery({
        escapeName: (name) => '"' + name + '"',
        escapeParam: (index) => '$' + (index + 1),
        escapeString: (value) => "'" + value.replace(/'/g, "''") + "'"
      });
      return { rows: [{ campaign_id: auditRow.outcomeCampaignId, click_count: "40", attributed_conversion_count: "2", attributed_revenue_cents: "5000", attributed_commission_cents: "500" }] };
    }
  };
  const audits = await new DrizzleAutonomousDecisionAuditRepository(db).list({ selected: true, limit: 100 });
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]?.outcome?.analytics, { clickCount: 40, attributedConversionCount: 2, attributedRevenueCents: 5000, attributedCommissionCents: 500, conversionRate: 0.05 });
  assert.ok(compiled);
  assert.match(compiled!.sql, /WITH target_campaigns AS/);
  assert.match(compiled!.sql, /click_analytics AS/);
  assert.match(compiled!.sql, /conversion_analytics AS/);
  assert.match(compiled!.sql, /commission_analytics AS/);
  assert.doesNotMatch(compiled!.sql, /SELECT COUNT\(\*\) FROM clicks cl JOIN tracking_links/);
  assert.equal(compiled!.params.length, 1);
  assert.equal(compiled!.params[0], auditRow.outcomeCampaignId);
});

test("decision audit listing skips analytics query when no audit has campaign outcomes", async () => {
  let analyticsQueries = 0;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ id: "audit-2", cycleId: "cycle-2", productId: "product-2", marketplaceId: "marketplace-1", selected: false, score: 0, policy: {}, reasons: [], createdAt: "2026-11-11T00:00:00.000Z" }] }) }) }) }),
    execute: async () => { analyticsQueries += 1; return { rows: [] }; }
  };
  const audits = await new DrizzleAutonomousDecisionAuditRepository(db).list({ selected: false });
  assert.equal(audits.length, 1);
  assert.equal(analyticsQueries, 0);
});
