import { useEffect, useMemo, useState } from "react";
import type {
  Affiliate,
  AnalyticsOverview,
  Commission,
  Conversion,
  MarketplaceConnectionView,
  MarketplaceProviderInfo,
  Offer
} from "@affiliateos/shared";
import { api } from "./api/client";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { IntegrationSetupPanel } from "./components/IntegrationSetupPanel";
import { AutonomousObservabilityPanel } from "./components/AutonomousObservabilityPanel";
import "./styles.css";

type DashboardData = {
  affiliates: Affiliate[];
  offers: Offer[];
  conversions: Conversion[];
  commissions: Commission[];
  marketplaceProviders: MarketplaceProviderInfo[];
  marketplaceConnections: MarketplaceConnectionView[];
  analytics: AnalyticsOverview;
};

const money = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
}).format(cents / 100);

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [affiliateName, setAffiliateName] = useState("");
  const [affiliateEmail, setAffiliateEmail] = useState("");
  const [isCreatingAffiliate, setIsCreatingAffiliate] = useState(false);
  const [offerName, setOfferName] = useState("");
  const [offerRate, setOfferRate] = useState("");
  const [isCreatingOffer, setIsCreatingOffer] = useState(false);
  const [togglingMarketplaceSlug, setTogglingMarketplaceSlug] = useState<string | null>(null);
  const [autonomousStatus, setAutonomousStatus] = useState<{ running: boolean; active: boolean; lastStartedAt?: string; lastCompletedAt?: string; lastError?: string } | null>(null);
  const [runningAutonomousCycle, setRunningAutonomousCycle] = useState(false);

  const loadDashboard = async () => {
    const [affiliates, offers, conversions, commissions, marketplaceProviders, marketplaceConnections, analytics, autonomous] = await Promise.all([
      api.affiliates(),
      api.offers(),
      api.conversions(),
      api.commissions(),
      api.marketplaceProviders(),
      api.marketplaceConnections(),
      api.analyticsOverview(),
      api.autonomousStatus()
    ]);
    setData({
      affiliates: affiliates.data,
      offers: offers.data,
      conversions: conversions.data,
      commissions: commissions.data,
      marketplaceProviders: marketplaceProviders.data,
      marketplaceConnections: marketplaceConnections.data,
      analytics
    });
    setAutonomousStatus(autonomous);
  };

  useEffect(() => {
    loadDashboard().catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Unable to load dashboard data.");
    });
  }, []);

  const handleCreateAffiliate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreatingAffiliate(true);
    setError(null);
    try {
      await api.createAffiliate({ name: affiliateName.trim(), email: affiliateEmail.trim() });
      setAffiliateName("");
      setAffiliateEmail("");
      await loadDashboard();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create affiliate.");
    } finally {
      setIsCreatingAffiliate(false);
    }
  };

  const handleCreateOffer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreatingOffer(true);
    setError(null);
    try {
      await api.createOffer({
        name: offerName.trim(),
        status: "active",
        commissionRateBps: Math.round(Number(offerRate) * 100)
      });
      setOfferName("");
      setOfferRate("");
      await loadDashboard();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create offer.");
    } finally {
      setIsCreatingOffer(false);
    }
  };

  const handleMarketplaceToggle = async (connection: MarketplaceConnectionView) => {
    const enable = !connection.enabled;
    if (enable) {
      const confirmed = window.confirm(`Enable marketplace connection “${connection.name}”?

This will allow AffiliateOS to use this marketplace connection for operational workflows.`);
      if (!confirmed) return;
    }

    setTogglingMarketplaceSlug(connection.slug);
    setError(null);
    try {
      await api.marketplaceSetEnabled(connection.slug, enable);
      await loadDashboard();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to change marketplace connection state.");
    } finally {
      setTogglingMarketplaceSlug(null);
    }
  };

  const handleRunAutonomousCycle = async () => {
    setRunningAutonomousCycle(true);
    setError(null);
    try {
      const response = await api.runAutonomousCycle();
      if (response.status === "failed") throw new Error(response.error ?? "Autonomous cycle failed.");
      await loadDashboard();
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "Unable to run autonomous cycle.");
    } finally {
      setRunningAutonomousCycle(false);
    }
  };

  const metrics = useMemo(() => {
    if (!data) return [];
    return [
      { label: "Clicks", value: data.analytics.clickCount.toLocaleString(), detail: `${data.analytics.trackingLinkCount} tracking links` },
      { label: "Attributed conversions", value: data.analytics.attributedConversionCount.toLocaleString(), detail: `${percent(data.analytics.conversionRate)} conversion rate` },
      { label: "Attributed revenue", value: money(data.analytics.attributedRevenueCents), detail: "Explicit tracking attribution only" },
      { label: "Attributed commission", value: money(data.analytics.attributedCommissionCents), detail: "Linked conversion commissions" }
    ];
  }, [data]);

  if (error) {
    return <main className="app"><section className="error-card"><span className="eyebrow">AffiliateOS</span><h1>Dashboard unavailable.</h1><p>{error}</p><button onClick={() => window.location.reload()}>Retry</button></section></main>;
  }

  if (!data) {
    return <main className="app"><section className="loading"><span className="eyebrow">AffiliateOS</span><p>Loading operations data...</p></section></main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">AffiliateOS</div>
          <p className="sidebar-label">Operations</p>
          <nav>
            <a className="nav-item active" href="#overview">Overview</a>
            <a className="nav-item" href="#analytics">Analytics</a>
            <a className="nav-item" href="#autonomous">Autonomous</a>\n            <a className="nav-item" href="#autonomous-observability">Decision Trace</a>
            <a className="nav-item" href="#workflows">Workflows</a>
            <a className="nav-item" href="#affiliates">Affiliates</a>
            <a className="nav-item" href="#offers">Offers</a>
            <a className="nav-item" href="#marketplaces">Marketplace Connections</a>
            <a className="nav-item" href="#conversions">Conversions</a>
            <a className="nav-item" href="#commissions">Commissions</a>
          </nav>
        </div>
        <div className="sidebar-footer"><span className="status-dot" />API connected</div>
      </aside>

      <main className="content" id="overview">
        <header className="topbar">
          <div><p className="kicker">Operations workspace</p><h1>Overview</h1></div>
          <span className="date-label">{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date())}</span>
        </header>

        <section className="welcome">
          <p className="eyebrow">AffiliateOS / Overview</p>
          <h2>Partnerships, with a clear line of sight.</h2>
          <p>Live operational data from the API, including explicit conversion attribution and database-backed campaign analytics.</p>
        </section>

        <section className="metrics-grid" aria-label="Analytics metrics">
          {metrics.map((metric) => <article className="metric-card" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></article>)}
        </section>

        <section className="workspace-grid" id="autonomous">
          <article className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Automation</p><h3>Autonomous engine</h3></div><span className={`badge ${autonomousStatus?.running ? "active" : "inactive"}`}>{autonomousStatus?.running ? "running" : "stopped"}</span></div>
            <p>{autonomousStatus?.active ? "A cycle is currently executing." : "Discovery, selection, campaign execution, and optimization are available from the autonomous cycle."}</p>
            {autonomousStatus?.lastCompletedAt && <small>Last completed: {new Date(autonomousStatus.lastCompletedAt).toLocaleString()}</small>}
            {autonomousStatus?.lastError && <p className="error-message">{autonomousStatus.lastError}</p>}
            <div className="affiliate-form"><button type="button" onClick={() => void handleRunAutonomousCycle()} disabled={runningAutonomousCycle || autonomousStatus?.active}>{runningAutonomousCycle ? "Running..." : autonomousStatus?.active ? "Cycle active" : "Run cycle now"}</button></div>
          </article>
        </section>

        <AutonomousObservabilityPanel />\n\n        <section className="analytics-section" id="analytics">
          <div className="section-heading"><div><p className="eyebrow">Performance</p><h2>Campaign analytics</h2></div><span>{data.analytics.campaignCount} campaigns</span></div>
          {data.analytics.campaigns.length === 0 ? <p className="empty">No campaign analytics yet. Create a campaign and attach tracking links to begin measuring it.</p> : (
            <div className="analytics-table-wrap">
              <table className="analytics-table">
                <thead><tr><th>Campaign</th><th>Clicks</th><th>Links</th><th>Content</th><th>Conversions</th><th>Revenue</th><th>Rate</th></tr></thead>
                <tbody>{data.analytics.campaigns.map((campaign) => (
                  <tr key={campaign.campaignId}>
                    <td><strong>{campaign.campaignId.slice(0, 8)}</strong></td>
                    <td>{campaign.clickCount.toLocaleString()}</td>
                    <td>{campaign.trackingLinkCount}</td>
                    <td>{campaign.contentCount}<small>{campaign.publishedContentCount} published</small></td>
                    <td>{campaign.attributedConversionCount}</td>
                    <td>{money(campaign.attributedRevenueCents)}</td>
                    <td>{percent(campaign.conversionRate)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="analytics-note">Revenue and conversion metrics use only explicit conversion-to-tracking-link attribution; legacy conversions are not implicitly assigned to campaigns.</p>
        </section>

        <WorkflowPanel />

        <IntegrationSetupPanel />

        <section className="workspace-grid">
          <article className="panel" id="conversions">
            <div className="panel-heading"><div><p className="eyebrow">Activity</p><h3>Recent conversions</h3></div><span>{data.conversions.length} total</span></div>
            {data.conversions.length === 0 ? <p className="empty">No conversions recorded yet.</p> : <div className="record-list">{data.conversions.slice(0, 5).map((conversion) => <div className="record" key={conversion.id}><div><strong>{money(conversion.amountCents)}</strong><small>{conversion.id.slice(0, 8)}</small></div><span className={`badge ${conversion.status}`}>{conversion.status}</span></div>)}</div>}
          </article>
          <article className="panel" id="commissions">
            <div className="panel-heading"><div><p className="eyebrow">Earnings</p><h3>Commissions</h3></div><span>{data.commissions.length} total</span></div>
            {data.commissions.length === 0 ? <p className="empty">No commissions recorded yet.</p> : <div className="record-list">{data.commissions.slice(0, 5).map((commission) => <div className="record" key={commission.id}><div><strong>{money(commission.amountCents)}</strong><small>{commission.id.slice(0, 8)}</small></div><span className={`badge ${commission.status}`}>{commission.status}</span></div>)}</div>}
          </article>
        </section>

        <section className="summary-grid">
          <article id="marketplaces">
            <span className="eyebrow">Integrations</span><h3>Marketplace Connections</h3>
            <p>Credential references are never displayed. New connections remain disabled until you explicitly confirm activation.</p>
            <div className="affiliate-list">{data.marketplaceProviders.length === 0 ? <p className="empty">No marketplace providers are registered.</p> : data.marketplaceProviders.map((provider) => <div className="affiliate-row" key={provider.slug}><div><strong>{provider.displayName}</strong><small>{provider.connectionMode === "mock" ? "Tests only — not a live marketplace connection" : "Official API adapter"}</small><small>Capabilities: {provider.capabilities.join(", ") || "none"}</small></div><span className={`badge ${provider.configured ? "active" : "inactive"}`}>{provider.configured ? "configured" : "unconfigured"}</span></div>)}</div>
            <div className="affiliate-list connection-list">{data.marketplaceConnections.length === 0 ? <p className="empty">No connections configured.</p> : data.marketplaceConnections.map((connection) => <div className="affiliate-row" key={connection.id}><div><strong>{connection.name}</strong><small>{connection.providerSlug} · {connection.connectionMode === "mock" ? "test adapter" : "official API"}</small><small>Last check: {connection.lastSuccessfulCheckAt ? new Date(connection.lastSuccessfulCheckAt).toLocaleString() : "not verified"}</small></div><div className="affiliate-meta"><span className={`badge ${connection.enabled ? "active" : "inactive"}`}>{connection.enabled ? "enabled" : "disabled"}</span><button type="button" onClick={() => void handleMarketplaceToggle(connection)} disabled={togglingMarketplaceSlug === connection.slug}>{togglingMarketplaceSlug === connection.slug ? "Saving..." : connection.enabled ? "Disable" : "Enable"}</button><small>{connection.healthStatus}</small></div></div>)}</div>
          </article>

          <article id="affiliates">
            <span className="eyebrow">Partners</span><h3>Affiliates</h3><p>{data.affiliates.length} affiliate records in the system.</p>
            <form className="affiliate-form" onSubmit={handleCreateAffiliate}><input type="text" placeholder="Affiliate name" value={affiliateName} onChange={(event) => setAffiliateName(event.target.value)} required /><input type="email" placeholder="Affiliate email" value={affiliateEmail} onChange={(event) => setAffiliateEmail(event.target.value)} required /><button type="submit" disabled={isCreatingAffiliate}>{isCreatingAffiliate ? "Adding..." : "Add Affiliate"}</button></form>
            <div className="affiliate-list">{data.affiliates.map((affiliate) => <div className="affiliate-row" key={affiliate.id}><div><strong>{affiliate.name}</strong><small>{affiliate.email}</small></div><div className="affiliate-meta"><span className={`badge ${affiliate.status}`}>{affiliate.status}</span><small>{affiliate.id.slice(0, 8)}</small></div></div>)}</div>
          </article>

          <article id="offers">
            <span className="eyebrow">Commercial</span><h3>Offers</h3><p>{data.offers.length} offers currently available in the system.</p>
            <form className="affiliate-form" onSubmit={handleCreateOffer}><input type="text" placeholder="Offer name" value={offerName} onChange={(event) => setOfferName(event.target.value)} required /><input type="number" min="0" step="0.01" placeholder="Commission rate (%)" value={offerRate} onChange={(event) => setOfferRate(event.target.value)} required /><button type="submit" disabled={isCreatingOffer}>{isCreatingOffer ? "Adding..." : "Add Offer"}</button></form>
            <div className="affiliate-list">{data.offers.map((offer) => <div className="affiliate-row" key={offer.id}><div><strong>{offer.name}</strong><small>{offer.commissionRateBps / 100}% commission</small></div><div className="affiliate-meta"><span className={`badge ${offer.status}`}>{offer.status}</span><small>{offer.id.slice(0, 8)}</small></div></div>)}</div>
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;