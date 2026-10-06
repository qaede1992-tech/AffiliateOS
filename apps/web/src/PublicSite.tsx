import { useMemo } from "react";

type PublicPage = "home" | "terms" | "privacy";

const pageFromPath = (pathname: string): PublicPage => {
  if (pathname === "/terms" || pathname === "/terms/") return "terms";
  if (pathname === "/privacy" || pathname === "/privacy/") return "privacy";
  return "home";
};

const navTo = (path: string) => {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

function PublicHeader({ page }: { page: PublicPage }) {
  return (
    <header className="public-header">
      <a className="public-brand" href="/" onClick={(event) => { event.preventDefault(); navTo("/"); }}>
        AffiliateOS
      </a>
      <nav className="public-nav" aria-label="Primary navigation">
        <a href="/#how-it-works">How it works</a>
        <a href="/terms" className={page === "terms" ? "current" : ""} onClick={(event) => { event.preventDefault(); navTo("/terms"); }}>Terms</a>
        <a href="/privacy" className={page === "privacy" ? "current" : ""} onClick={(event) => { event.preventDefault(); navTo("/privacy"); }}>Privacy</a>
        <a className="public-nav-button" href="/app">Open dashboard</a>
      </nav>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <div>
        <strong>AffiliateOS</strong>
        <p>Affiliate operations infrastructure for product discovery, campaign execution, attribution, and optimization.</p>
      </div>
      <nav aria-label="Legal navigation">
        <a href="/terms" onClick={(event) => { event.preventDefault(); navTo("/terms"); }}>Terms of Service</a>
        <a href="/privacy" onClick={(event) => { event.preventDefault(); navTo("/privacy"); }}>Privacy Policy</a>
      </nav>
    </footer>
  );
}

function Home() {
  return (
    <>
      <section className="public-hero">
        <div className="public-hero-copy">
          <p className="public-eyebrow">Affiliate operations platform</p>
          <h1>Turn affiliate opportunities into measurable campaigns.</h1>
          <p className="public-lead">
            AffiliateOS brings product discovery, affiliate offers, campaign workflows, content operations,
            conversion attribution, and performance feedback into one operational workspace.
          </p>
          <div className="public-actions">
            <a className="public-primary-button" href="/app">Open AffiliateOS</a>
            <a className="public-secondary-button" href="#how-it-works">See how it works</a>
          </div>
        </div>
        <div className="public-hero-card" aria-label="AffiliateOS workflow">
          <span>OPERATING MODEL</span>
          <strong>Discover → Select → Publish → Measure → Improve</strong>
          <p>Designed so marketplace and publishing connections can be added through explicit, controlled integrations.</p>
        </div>
      </section>

      <section className="public-section" id="how-it-works">
        <div className="public-section-heading">
          <p className="public-eyebrow">How it works</p>
          <h2>A single operational loop for affiliate growth.</h2>
        </div>
        <div className="public-feature-grid">
          <article>
            <span>01</span>
            <h3>Discover</h3>
            <p>Bring product and affiliate-offer data into AffiliateOS through supported marketplace connections and feeds.</p>
          </article>
          <article>
            <span>02</span>
            <h3>Select</h3>
            <p>Evaluate offers using product, commission, availability, audience, and performance signals.</p>
          </article>
          <article>
            <span>03</span>
            <h3>Execute</h3>
            <p>Organize campaigns and content workflows while keeping external accounts and credentials under explicit control.</p>
          </article>
          <article>
            <span>04</span>
            <h3>Measure</h3>
            <p>Track clicks, conversions, attributed revenue, and commissions using explicit attribution data.</p>
          </article>
          <article>
            <span>05</span>
            <h3>Improve</h3>
            <p>Use operational outcomes and decision traces to support future product and campaign selection.</p>
          </article>
          <article>
            <span>06</span>
            <h3>Connect safely</h3>
            <p>External marketplace and social connections are opt-in integrations; unsupported platforms are not represented as live integrations.</p>
          </article>
        </div>
      </section>

      <section className="public-section public-trust">
        <div>
          <p className="public-eyebrow">Built for controlled automation</p>
          <h2>Automation with observable decisions and explicit integrations.</h2>
        </div>
        <p>
          AffiliateOS is designed to keep operational data, attribution, publishing workflows, and external
          credentials separated. Credential values are not exposed through normal account views, and integrations
          are activated explicitly.
        </p>
      </section>
    </>
  );
}

function LegalPage({ type }: { type: "terms" | "privacy" }) {
  const isTerms = type === "terms";
  return (
    <article className="public-legal">
      <p className="public-eyebrow">{isTerms ? "Legal" : "Privacy"}</p>
      <h1>{isTerms ? "Terms of Service" : "Privacy Policy"}</h1>
      <p className="public-legal-updated">Effective date: October 6, 2026</p>

      {isTerms ? (
        <>
          <p>These Terms of Service govern access to and use of AffiliateOS, an affiliate operations platform provided through the AffiliateOS website and application.</p>
          <h2>1. Use of the service</h2>
          <p>You may use AffiliateOS only in compliance with applicable laws and the terms of the third-party marketplaces, social platforms, and other services you connect to it. You are responsible for the accounts and permissions you authorize.</p>
          <h2>2. Integrations and credentials</h2>
          <p>AffiliateOS may support integrations with external services. Integration availability can vary by platform, approval status, region, and account eligibility. You must not provide credentials that you are not authorized to use. AffiliateOS is not responsible for changes to third-party APIs, policies, availability, or account status.</p>
          <h2>3. Affiliate and campaign data</h2>
          <p>You are responsible for the accuracy and lawful use of product, offer, campaign, content, tracking, conversion, and commission data submitted to the service. Attribution and analytics depend on the data and integrations available to AffiliateOS and should not be treated as a guarantee of commission or revenue.</p>
          <h2>4. Automated workflows</h2>
          <p>Some AffiliateOS workflows may automate discovery, selection, campaign operations, or publishing actions. You remain responsible for reviewing the configuration and permissions of connected accounts and for complying with applicable platform rules.</p>
          <h2>5. Prohibited use</h2>
          <p>You may not use AffiliateOS to violate laws, platform policies, intellectual property rights, privacy rights, security controls, or access restrictions, or to distribute deceptive or unauthorized content.</p>
          <h2>6. Availability and changes</h2>
          <p>AffiliateOS may change, suspend, or discontinue features, including third-party integrations, as necessary to maintain the service, respond to provider changes, or address security and compliance requirements.</p>
          <h2>7. Disclaimer</h2>
          <p>The service is provided on an availability basis. AffiliateOS does not guarantee a particular affiliate approval, audience reach, conversion rate, commission, revenue result, or uninterrupted third-party integration.</p>
          <h2>8. Contact and questions</h2>
          <p>Questions about these terms should be directed through the support or contact mechanism made available with your AffiliateOS service account.</p>
        </>
      ) : (
        <>
          <p>This Privacy Policy explains how AffiliateOS handles information used to provide its affiliate operations service, including account, integration, campaign, tracking, and operational data.</p>
          <h2>1. Information we process</h2>
          <p>Depending on how you use the service, AffiliateOS may process account information, authentication and authorization information, marketplace and affiliate data, campaign and content data, tracking and conversion events, operational logs, and information required to connect approved third-party accounts.</p>
          <h2>2. Credentials and access tokens</h2>
          <p>External credentials and access tokens are handled as protected integration data. Normal social-account views do not expose token values. Where supported, credential references are stored separately from ordinary account metadata.</p>
          <h2>3. How information is used</h2>
          <p>Information is used to operate AffiliateOS, authenticate operators, execute configured workflows, connect approved integrations, measure campaign performance, provide attribution and analytics, troubleshoot failures, and improve service reliability and security.</p>
          <h2>4. Third-party services</h2>
          <p>When you connect a marketplace or social platform, information may be exchanged with that provider as necessary to perform the action you authorize. Those providers process information under their own privacy policies and terms.</p>
          <h2>5. Security</h2>
          <p>AffiliateOS uses access controls and protected credential-handling mechanisms appropriate to the service. No internet service can guarantee absolute security, so users should protect their authentication credentials and promptly revoke integrations they no longer authorize.</p>
          <h2>6. Retention</h2>
          <p>Information is retained for as long as reasonably necessary to provide the service, maintain operational records, meet security requirements, resolve disputes, or comply with legal obligations, subject to applicable requirements and configured retention policies.</p>
          <h2>7. Your choices</h2>
          <p>You can manage connected accounts and permissions through the available AffiliateOS controls and the relevant third-party provider. You may also request information about your data through the support or contact mechanism made available with your service account.</p>
          <h2>8. Policy changes</h2>
          <p>This policy may be updated when the service, integrations, or legal requirements change. The effective date at the top of this page indicates the current version.</p>
        </>
      )}
    </article>
  );
}

export function PublicSite() {
  const [page, setPage] = useState<PublicPage>(pageFromPath(window.location.pathname));

  useMemo(() => {
    const onPopState = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <div className="public-site">
      <PublicHeader page={page} />
      <main>
        {page === "home" ? <Home /> : <LegalPage type={page} />}
      </main>
      <PublicFooter />
    </div>
  );
}
