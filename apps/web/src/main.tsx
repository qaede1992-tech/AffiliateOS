import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <header className="header">
        <span className="eyebrow">AffiliateOS</span>
        <span className="status">Foundation online</span>
      </header>
      <section className="hero">
        <p className="kicker">Operations workspace</p>
        <h1>Partnerships, with a clear line of sight.</h1>
        <p className="intro">
          The AffiliateOS foundation is ready for affiliates, offers, conversions, and commissions.
        </p>
      </section>
      <section className="domain-grid" aria-label="AffiliateOS domains">
        {[
          ["01", "Affiliates", "Partner records and program status"],
          ["02", "Offers", "Commercial terms and availability"],
          ["03", "Conversions", "Attribution events and review states"],
          ["04", "Commissions", "Earnings calculated from approved activity"]
        ].map(([number, title, description]) => (
          <article className="domain" key={title}>
            <span className="number">{number}</span>
            <h2>{title}</h2>
            <p>{description}</p>
            <span className="empty-state">Not configured yet</span>
          </article>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);