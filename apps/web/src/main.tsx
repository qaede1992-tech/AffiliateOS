import { useEffect, useMemo, useState } from "react";
import type {
  Affiliate,
  Commission,
  Conversion,
  Offer
} from "@affiliateos/shared";
import { api } from "./api/client";
import "./styles.css";

type DashboardData = {
  affiliates: Affiliate[];
  offers: Offer[];
  conversions: Conversion[];
  commissions: Commission[];
};

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [affiliateName, setAffiliateName] = useState("");
  const [affiliateEmail, setAffiliateEmail] = useState("");
  const [isCreatingAffiliate, setIsCreatingAffiliate] = useState(false);

  const handleCreateAffiliate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreatingAffiliate(true);
    setError(null);

    try {
      await api.createAffiliate({
        name: affiliateName.trim(),
        email: affiliateEmail.trim()
      });
      const affiliates = await api.affiliates();
      setData((current) => current ? { ...current, affiliates: affiliates.data } : current);
      setAffiliateName("");
      setAffiliateEmail("");
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to create affiliate."
      );
    } finally {
      setIsCreatingAffiliate(false);
    }
  };

  useEffect(() => {
    Promise.all([
      api.affiliates(),
      api.offers(),
      api.conversions(),
      api.commissions()
    ])
      .then(([affiliates, offers, conversions, commissions]) => {
        setData({
          affiliates: affiliates.data,
          offers: offers.data,
          conversions: conversions.data,
          commissions: commissions.data
        });
      })
      .catch((requestError: unknown) => {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load dashboard data."
        );
      });
  }, []);

  const metrics = useMemo(() => {
    if (!data) {
      return [];
    }

    const pendingConversions = data.conversions.filter(
      (conversion) => conversion.status === "pending"
    ).length;

    const pendingCommissions = data.commissions.filter(
      (commission) => commission.status === "pending"
    ).length;

    return [
      {
        label: "Affiliates",
        value: data.affiliates.length,
        detail: "Partner records"
      },
      {
        label: "Offers",
        value: data.offers.length,
        detail: "Configured offers"
      },
      {
        label: "Conversions",
        value: data.conversions.length,
        detail: `${pendingConversions} pending`
      },
      {
        label: "Commissions",
        value: data.commissions.length,
        detail: `${pendingCommissions} pending`
      }
    ];
  }, [data]);

  if (error) {
    return (
      <main className="app">
        <section className="error-card">
          <span className="eyebrow">AffiliateOS</span>
          <h1>Dashboard unavailable.</h1>
          <p>{error}</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="app">
        <section className="loading">
          <span className="eyebrow">AffiliateOS</span>
          <p>Loading operations data...</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">AffiliateOS</div>
          <p className="sidebar-label">Operations</p>

          <nav>
            <a className="nav-item active" href="#overview">
              Overview
            </a>
            <a className="nav-item" href="#affiliates">
              Affiliates
            </a>
            <a className="nav-item" href="#offers">
              Offers
            </a>
            <a className="nav-item" href="#conversions">
              Conversions
            </a>
            <a className="nav-item" href="#commissions">
              Commissions
            </a>
          </nav>
        </div>

        <div className="sidebar-footer">
          <span className="status-dot" />
          API connected
        </div>
      </aside>

      <main className="content" id="overview">
        <header className="topbar">
          <div>
            <p className="kicker">Operations workspace</p>
            <h1>Overview</h1>
          </div>
          <span className="date-label">
            {new Intl.DateTimeFormat("en", {
              dateStyle: "medium"
            }).format(new Date())}
          </span>
        </header>

        <section className="welcome">
          <p className="eyebrow">AffiliateOS / Overview</p>
          <h2>Partnerships, with a clear line of sight.</h2>
          <p>
            A live view of affiliates, offers, conversions, and commissions
            connected to your operations database.
          </p>
        </section>

        <section className="metrics-grid" aria-label="Key metrics">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </article>
          ))}
        </section>

        <section className="workspace-grid">
          <article className="panel" id="conversions">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Activity</p>
                <h3>Recent conversions</h3>
              </div>
              <span>{data.conversions.length} total</span>
            </div>

            {data.conversions.length === 0 ? (
              <p className="empty">No conversions recorded yet.</p>
            ) : (
              <div className="record-list">
                {data.conversions.slice(0, 5).map((conversion) => (
                  <div className="record" key={conversion.id}>
                    <div>
                      <strong>
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD"
                        }).format(conversion.amountCents / 100)}
                      </strong>
                      <small>{conversion.id.slice(0, 8)}</small>
                    </div>
                    <span className={`badge ${conversion.status}`}>
                      {conversion.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>

          <article className="panel" id="commissions">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Earnings</p>
                <h3>Commissions</h3>
              </div>
              <span>{data.commissions.length} total</span>
            </div>

            {data.commissions.length === 0 ? (
              <p className="empty">No commissions recorded yet.</p>
            ) : (
              <div className="record-list">
                {data.commissions.slice(0, 5).map((commission) => (
                  <div className="record" key={commission.id}>
                    <div>
                      <strong>
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD"
                        }).format(commission.amountCents / 100)}
                      </strong>
                      <small>{commission.id.slice(0, 8)}</small>
                    </div>
                    <span className={`badge ${commission.status}`}>
                      {commission.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>

        <section className="summary-grid">
          <article id="affiliates">
            <span className="eyebrow">Partners</span>
            <h3>Affiliates</h3>
            <p>{data.affiliates.length} affiliate records in the system.</p>

            <form className="affiliate-form" onSubmit={handleCreateAffiliate}>
              <input
                type="text"
                placeholder="Affiliate name"
                value={affiliateName}
                onChange={(event) => setAffiliateName(event.target.value)}
                required
              />
              <input
                type="email"
                placeholder="Affiliate email"
                value={affiliateEmail}
                onChange={(event) => setAffiliateEmail(event.target.value)}
                required
              />
              <button type="submit" disabled={isCreatingAffiliate}>
                {isCreatingAffiliate ? "Adding..." : "Add Affiliate"}
              </button>
            </form>

            <div className="affiliate-list">
              {data.affiliates.map((affiliate) => (
                <div className="affiliate-row" key={affiliate.id}>
                  <div>
                    <strong>{affiliate.name}</strong>
                    <small>{affiliate.email}</small>
                  </div>
                  <div className="affiliate-meta">
                    <span className={`badge ${affiliate.status}`}>
                      {affiliate.status}
                    </span>
                    <small>{affiliate.id.slice(0, 8)}</small>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article id="offers">
            <span className="eyebrow">Commercial</span>
            <h3>Offers</h3>
            <p>{data.offers.length} offers currently available in the system.</p>
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(<App />);
