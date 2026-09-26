import { useEffect, useMemo, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api } from "../api/client";

type DecisionAudit = {
  auditId: string;
  cycleId: string;
  productId: string;
  marketplaceId: string;
  selected: boolean;
  selectionMode?: "exploration" | "exploitation";
  score: number;
  policy: Record<string, unknown>;
  reasons: string[];
  category?: string;
  audienceSegments?: string[];
  createdAt: string;
  recovery?: { anomaly: "none" | "watch" | "halt"; recoveryState: "none" | "recovering" | "recovered"; recoveryClicks: number; recoveryEvidenceScore: number; recoveryEpisodeId?: string };\n  performanceRegime?: "rising" | "stable" | "declining" | "volatile";\n  outcome?: {
    offerId?: string;
    status: "completed" | "failed";
    campaignId?: string;
    error?: string;
    observedAt: string;
    analytics?: {
      clickCount: number;
      attributedConversionCount: number;
      attributedRevenueCents: number;
      attributedCommissionCents: number;
      conversionRate: number;
    };
  };
};

type AutonomousRun = { id: string; idempotencyKey: string; productId: string; offerId: string; status: "accepted" | "processing" | "completed" | "failed"; attemptCount: number; campaignId?: string; lastError?: string; nextAttemptAt?: string; updatedAt: string };\ntype PublisherReadiness = { platform: string; status: string; reason?: string };\ntype AutonomousStatus = {
  running: boolean;
  active: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
};

const money = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
}).format(cents / 100);

const shortId = (value: string) => value.slice(0, 8);
const formatDate = (value?: string) => value ? new Date(value).toLocaleString() : "—";

export function AutonomousObservabilityPanel() {
  const [audits, setAudits] = useState<DecisionAudit[]>([]);
  const [products, setProducts] = useState<Product[]>([]);\n  const [runs, setRuns] = useState<AutonomousRun[]>([]);\n  const [readiness, setReadiness] = useState<PublisherReadiness[]>([]);
  const [status, setStatus] = useState<AutonomousStatus | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<"all" | "selected" | "rejected">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [auditResponse, productResponse, autonomousStatus] = await Promise.all([
        api.autonomousDecisionAudits(100),
        api.products(),
        api.autonomousStatus()
      ]);
      setAudits(auditResponse.data);
      setProducts(productResponse.data);
      setStatus(autonomousStatus);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load autonomous observability.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const filtered = useMemo(
    () => audits.filter((audit) => selectedFilter === "all" || (selectedFilter === "selected" ? audit.selected : !audit.selected)),
    [audits, selectedFilter]
  );
  const selectedCount = audits.filter((audit) => audit.selected).length;
  const rejectedCount = audits.length - selectedCount;
  const completedCount = audits.filter((audit) => audit.outcome?.status === "completed").length;
  const failedCount = audits.filter((audit) => audit.outcome?.status === "failed").length;\n  const recoveryCount = audits.filter((audit) => audit.recovery?.recoveryState === "recovering").length;\n  const haltedCount = audits.filter((audit) => audit.recovery?.anomaly === "halt").length;\n  const pendingRuns = runs.filter((run) => run.status === "accepted" || run.status === "processing").length;\n  const failedRuns = runs.filter((run) => run.status === "failed").length;

  if (loading) {
    return <section className="analytics-section" id="autonomous-observability"><div className="section-heading"><div><p className="eyebrow">Decision trace</p><h2>Autonomous selection</h2></div></div><p className="empty">Loading autonomous operations...</p></section>;
  }

  return (
    <section className="analytics-section" id="autonomous-observability">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Decision trace</p>
          <h2>Autonomous discovery & selection</h2>
        </div>
        <div className="affiliate-meta">
          <span className={`badge ${status?.active ? "active" : "inactive"}`}>{status?.active ? "cycle active" : "idle"}</span>
          <button type="button" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? "Refreshing..." : "Refresh"}</button>
        </div>
      </div>

      <div className="metrics-grid autonomous-observability-metrics">
        <article className="metric-card"><span>Audits</span><strong>{audits.length}</strong><small>Latest persisted selection decisions</small></article>
        <article className="metric-card"><span>Selected</span><strong>{selectedCount}</strong><small>Products selected for execution</small></article>
        <article className="metric-card"><span>Rejected</span><strong>{rejectedCount}</strong><small>Products retained with rejection reasons</small></article>
        <article className="metric-card"><span>Outcomes</span><strong>{completedCount}/{failedCount}</strong><small>Completed / failed execution outcomes</small></article>\n        <article className="metric-card"><span>Recovery</span><strong>{recoveryCount}</strong><small>{haltedCount} anomaly halt(s) in audit window</small></article>\n        <article className="metric-card"><span>Runs</span><strong>{pendingRuns}</strong><small>{failedRuns} failed persisted run(s)</small></article>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

      <div className="autonomous-observability-status">\n        {readiness.map((item) => <div key={item.platform}><strong>{item.platform} publisher</strong><span>{item.status}{item.reason ? ` · ${item.reason}` : ""}</span></div>)}
        <div><strong>Cycle status</strong><span>{status?.running ? "scheduler running" : "scheduler stopped"}{status?.active ? " · cycle active" : ""}</span></div>
        <div><strong>Last started</strong><span>{formatDate(status?.lastStartedAt)}</span></div>
        <div><strong>Last completed</strong><span>{formatDate(status?.lastCompletedAt)}</span></div>
        {status?.lastError && <div><strong>Last error</strong><span className="error-message">{status.lastError}</span></div>}
      </div>

      <div className="affiliate-form autonomous-filter">
        <div className="affiliate-meta">
          {(["all", "selected", "rejected"] as const).map((filter) => (
            <button key={filter} type="button" className={selectedFilter === filter ? "filter-active" : ""} onClick={() => setSelectedFilter(filter)}>
              {filter === "all" ? "All" : filter === "selected" ? "Selected" : "Rejected"}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="empty">No persisted autonomous decision audits match this filter. Run a cycle after an eligible marketplace connection and bound affiliate account are configured.</p>
      ) : (
        <div className="autonomous-audit-list">\n          {runs.length > 0 && <div className="autonomous-run-summary"><strong>Execution runs</strong><span>{runs.slice(0, 8).map((run) => `${shortId(run.productId)}:${run.status} (attempt ${run.attemptCount})`).join(" · ")}</span></div>}
          {filtered.map((audit) => {
            const product = productById.get(audit.productId);
            const breakdown = product ? undefined : undefined;
            return (
              <article className="autonomous-audit-card" key={audit.auditId}>
                <div className="autonomous-audit-header">
                  <div>
                    <strong>{product?.name ?? `Product ${shortId(audit.productId)}`}</strong>
                    <small>{product?.category ?? "Category unavailable"} · marketplace {shortId(audit.marketplaceId)} · cycle {shortId(audit.cycleId)}</small>
                  </div>
                  <div className="affiliate-meta">
                    <span className={`badge ${audit.selected ? "active" : "inactive"}`}>{audit.selected ? "selected" : "rejected"}</span>
                    {audit.selectionMode && <span className="badge">{audit.selectionMode}</span>}
                    <strong className="autonomous-score">{audit.score.toFixed(1)}</strong>
                  </div>
                </div>
                <div className="autonomous-audit-grid">
                  <div><span>Audience</span><strong>{audit.audienceSegments?.join(", ") || "not constrained"}</strong></div>
                  <div><span>Recorded</span><strong>{formatDate(audit.createdAt)}</strong></div>
                  <div><span>Outcome</span><strong>{audit.outcome ? audit.outcome.status : "not executed"}</strong></div>
                  <div><span>Offer</span><strong>{audit.outcome?.offerId ? shortId(audit.outcome.offerId) : "not bound"}</strong></div>\n                  <div><span>Performance</span><strong>{audit.performanceRegime ?? "not measured"}</strong></div>\n                  <div><span>Recovery</span><strong>{audit.recovery ? `${audit.recovery.anomaly} / ${audit.recovery.recoveryState}` : "none"}</strong></div>
                </div>
                <div className="autonomous-reasons">
                  <strong>{audit.selected ? "Selection evidence" : "Rejection reasons"}</strong>
                  {audit.reasons.length === 0 ? <span>No additional reasons recorded.</span> : <ul>{audit.reasons.map((reason, index) => <li key={`${audit.auditId}-reason-${index}`}>{reason}</li>)}</ul>}
                </div>
                {audit.outcome?.error && <p className="error-message">{audit.outcome.error}</p>}
                {audit.outcome?.analytics && (
                  <div className="autonomous-outcome">
                    <span>{audit.outcome.analytics.clickCount} clicks</span>
                    <span>{audit.outcome.analytics.attributedConversionCount} conversions</span>
                    <span>{money(audit.outcome.analytics.attributedRevenueCents)} revenue</span>
                    <span>{money(audit.outcome.analytics.attributedCommissionCents)} commission</span>
                    <span>{(audit.outcome.analytics.conversionRate * 100).toFixed(1)}% conversion rate</span>
                  </div>
                )}
                {breakdown && <span />}
              </article>
            );
          })}
        </div>
      )}

      <p className="analytics-note">This view uses persisted autonomous decision audits and campaign attribution. It does not invent discovery signals or imply that a score guarantees conversions or profit.</p>
    </section>
  );
}
