import { useEffect, useState } from "react";
import type { Affiliate, ImportShopeeAffiliateFeedRequest, MarketplaceConnectionView, MarketplaceProviderInfo, SocialAccountView } from "@affiliateos/shared";
import { api, socialOAuthRedirectUri } from "../api/client";

type Readiness = { platform: string; status: string; reason?: string };

export function IntegrationSetupPanel() {
  const [providers, setProviders] = useState<MarketplaceProviderInfo[]>([]);
  const [connections, setConnections] = useState<MarketplaceConnectionView[]>([]);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccountView[]>([]);
  const [readiness, setReadiness] = useState<Readiness[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialReference, setCredentialReference] = useState("");
  const [feedAffiliateId, setFeedAffiliateId] = useState("");
  const [feedJson, setFeedJson] = useState("");

  const load = async () => {
    const [p, c, a, s, r] = await Promise.all([
      api.marketplaceProviders(), api.marketplaceConnections(), api.affiliates(),
      api.socialAccounts(), api.publisherReadiness()
    ]);
    setProviders(p.data); setConnections(c.data); setAffiliates(a.data); setSocialAccounts(s.data); setReadiness(r.data);
  };

  useEffect(() => { void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "Unable to load integration setup.")); }, []);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setError(null); setMessage(null);
    try { await action(); setMessage(success); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Operation failed."); }
    finally { setBusy(null); }
  };

  const importShopeeFeed = () => run("import-shopee-feed", async () => {
    if (!feedAffiliateId) throw new Error("Pilih affiliate terlebih dahulu.");
    const parsed = JSON.parse(feedJson) as unknown;
    const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : null);
    if (!items) throw new Error("Format feed harus berupa array JSON atau objek { items: [...] }.");
    const request: ImportShopeeAffiliateFeedRequest = { affiliateId: feedAffiliateId, items: items as ImportShopeeAffiliateFeedRequest["items"] };
    const result = await api.importShopeeAffiliateFeed(request);
    setFeedJson("");
    setFeedAffiliateId("");
    setMessage(`Feed diimpor: ${result.importedProducts} produk, ${result.importedOffers} affiliate offer.`);
  }, "Shopee Affiliate Feed berhasil diimpor.");

  const createShopee = () => run("create-shopee", async () => {
    const slug = "shopee";
    if (connections.some((c) => c.slug === slug)) return;
    await api.createMarketplaceConnection({
      name: "Shopee", slug, providerSlug: "shopee",
      credentialReference: credentialReference.trim() || undefined
    });
  }, "Shopee connection created and remains disabled until explicitly enabled.");

  const startOAuth = async (platform: "instagram" | "tiktok") => {
    setBusy(platform); setError(null); setMessage(null);
    try {
      const redirectUri = socialOAuthRedirectUri();
      const response = await api.startSocialOAuth({ platform, redirectUri });
      window.location.assign(response.authorizationUrl);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to start OAuth."); setBusy(null); }
  };

  return (
    <section className="workspace-grid" id="integrations">
      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Production setup</p><h3>Marketplace & social integrations</h3></div></div>
        <p>Connect only through configured official providers. AffiliateOS never asks this dashboard to store marketplace or social secrets.</p>
        {error && <p className="error-message">{error}</p>}
        {message && <p>{message}</p>}

        <div className="affiliate-form">
          <label>Opaque Shopee credential reference (optional)<input value={credentialReference} onChange={(e) => setCredentialReference(e.target.value)} placeholder="e.g. vault://affiliateos/shopee/prod" /></label>
          <button type="button" onClick={() => void createShopee()} disabled={busy !== null || !providers.some((p) => p.slug === "shopee" && p.configured)}>
            {busy === "create-shopee" ? "Creating..." : "Add Shopee connection"}
          </button>
        </div>

        <div className="affiliate-form">
          <label>Import Shopee Affiliate Product Feed (JSON)
            <select value={feedAffiliateId} onChange={(e) => setFeedAffiliateId(e.target.value)}>
              <option value="">Pilih affiliate...</option>
              {affiliates.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
            </select>
            <textarea value={feedJson} onChange={(e) => setFeedJson(e.target.value)} placeholder={'Paste JSON array feed Shopee di sini. Contoh: [{"externalProductId":"...","name":"...","priceCents":100000,"currency":"IDR","productUrl":"https://shopee.co.id/...","affiliateUrl":"https://s.shopee.co.id/..."}]'} rows={8} />
          </label>
          <button type="button" onClick={() => void importShopeeFeed()} disabled={busy !== null || affiliates.length === 0 || !feedJson.trim()}>
            {busy === "import-shopee-feed" ? "Importing..." : "Import Shopee Feed"}
          </button>
          <small>Import-only. AffiliateOS tidak memanggil Open API atau melakukan scraping Shopee.</small>
        </div>

        <div className="affiliate-list">
          {connections.length === 0 ? <p className="empty">No marketplace connections configured.</p> : connections.map((connection) => (
            <div className="affiliate-row" key={connection.id}>
              <div><strong>{connection.name}</strong><small>{connection.providerSlug} · {connection.connectionMode === "affiliate_feed" ? "affiliate feed" : connection.connectionMode}</small><small>Affiliate binding must point to an existing internal affiliate.</small></div>
              <div className="affiliate-meta">
                <span className={`badge ${connection.enabled ? "active" : "inactive"}`}>{connection.enabled ? "enabled" : "disabled"}</span>
                {connection.connectionMode !== "affiliate_feed" && <button type="button" onClick={() => void run(`test-${connection.slug}`, () => api.marketplaceTest(connection.slug), "Marketplace connection tested.")} disabled={busy !== null}>Test</button>}
                {affiliates.length > 0 && <select defaultValue="" onChange={(e) => { if (e.target.value) void run(`bind-${connection.slug}`, () => api.bindMarketplaceAffiliate(connection.slug, e.target.value), "Affiliate account bound."); }}>
                  <option value="">Bind affiliate...</option>
                  {affiliates.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
                </select>}
                {connection.connectionMode !== "affiliate_feed" && <button type="button" onClick={() => void run(`discover-${connection.slug}`, () => api.discoverMarketplaceProducts(connection.slug), "Product discovery completed.")} disabled={busy !== null || !connection.enabled}>Discover</button>}
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Official social publishing</p><h3>Instagram & TikTok</h3></div></div>
        <p>OAuth is the only dashboard credential path. Publishing readiness is evaluated from configured official credentials, account state, and required scopes.</p>
        <div className="affiliate-list">
          {(["instagram", "tiktok"] as const).map((platform) => {
            const account = socialAccounts.find((a) => a.platform === platform);
            const status = readiness.find((r) => r.platform === platform);
            return <div className="affiliate-row" key={platform}>
              <div><strong>{platform}</strong><small>{account ? `Account: ${account.accountReference}` : "No account connected"}</small><small>Readiness: {status?.status ?? "unknown"}{status?.reason ? ` — ${status.reason}` : ""}</small></div>
              <div className="affiliate-meta"><span className={`badge ${account?.status === "active" && status?.status === "ready" ? "active" : "inactive"}`}>{status?.status ?? "unconfigured"}</span><button type="button" onClick={() => void startOAuth(platform)} disabled={busy !== null}>{busy === platform ? "Redirecting..." : account ? "Reconnect" : "Connect"}</button></div>
            </div>;
          })}
        </div>
      </article>
    </section>
  );
}
