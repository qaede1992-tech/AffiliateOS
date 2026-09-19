import { useEffect, useState } from "react";
import type { AffiliateOffer, Campaign, Content, ContentPlatform, SocialAccountView, TrackingLink } from "@affiliateos/shared";
import { api } from "../api/client";

const platforms: ContentPlatform[] = ["tiktok", "instagram", "facebook", "youtube-shorts", "x", "threads"];

export function WorkflowPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [content, setContent] = useState<Content[]>([]);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccountView[]>([]);
  const [affiliateOffers, setAffiliateOffers] = useState<AffiliateOffer[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [campaignName, setCampaignName] = useState("");
  const [campaignObjective, setCampaignObjective] = useState("");
  const [contentTitle, setContentTitle] = useState("");
  const [contentPlatform, setContentPlatform] = useState<ContentPlatform>("tiktok");
  const [contentType, setContentType] = useState("short-form");
  const [contentCampaignId, setContentCampaignId] = useState("");
  const [accountPlatform, setAccountPlatform] = useState("tiktok");
  const [accountReference, setAccountReference] = useState("");
  const [trackingOfferId, setTrackingOfferId] = useState("");
  const [trackingCampaignId, setTrackingCampaignId] = useState("");
  const [trackingDestination, setTrackingDestination] = useState("");
  const [trackingCode, setTrackingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [campaignResponse, contentResponse, socialResponse, offerResponse, linkResponse] = await Promise.all([api.campaigns(), api.content(), api.socialAccounts(), api.affiliateOffers(), api.trackingLinks()]);
    setCampaigns(campaignResponse.data); setContent(contentResponse.data); setSocialAccounts(socialResponse.data); setAffiliateOffers(offerResponse.data); setTrackingLinks(linkResponse.data);
  };

  useEffect(() => { refresh().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Unable to load workflow data.")); }, []);

  const run = async (operation: () => Promise<unknown>, clear: () => void) => {
    setBusy(true); setError(null);
    try { await operation(); clear(); await refresh(); }
    catch (requestError: unknown) { setError(requestError instanceof Error ? requestError.message : "Operation failed."); }
    finally { setBusy(false); }
  };

  return (
    <section className="workflow-section" id="workflows">
      <div className="section-heading"><div><p className="eyebrow">Execution</p><h2>Campaign & social workflows</h2></div><span>Operational controls</span></div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="workspace-grid">
        <article className="panel" id="campaigns">
          <div className="panel-heading"><div><p className="eyebrow">Planning</p><h3>Campaigns</h3></div><span>{campaigns.length} total</span></div>
          <form className="affiliate-form" onSubmit={(event) => { event.preventDefault(); void run(() => api.createCampaign({ name: campaignName.trim(), objective: campaignObjective.trim(), status: "draft" }), () => { setCampaignName(""); setCampaignObjective(""); }); }}>
            <input placeholder="Campaign name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} required />
            <input placeholder="Objective" value={campaignObjective} onChange={(event) => setCampaignObjective(event.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Saving..." : "Create campaign"}</button>
          </form>
          <div className="affiliate-list">{campaigns.length === 0 ? <p className="empty">No campaigns yet.</p> : campaigns.map((campaign) => <div className="affiliate-row" key={campaign.id}><div><strong>{campaign.name}</strong><small>{campaign.objective}</small></div><div className="affiliate-meta"><span className={`badge ${campaign.status}`}>{campaign.status}</span><small>{campaign.id.slice(0, 8)}</small></div></div>)}</div>
        </article>

        <article className="panel" id="tracking-links">
          <div className="panel-heading"><div><p className="eyebrow">Attribution</p><h3>Tracking links</h3></div><span>{trackingLinks.length} total</span></div>
          {affiliateOffers.length === 0 ? <p className="empty">No affiliate offers are persisted yet. Discover marketplace products and offers first.</p> : <form className="affiliate-form" onSubmit={(event) => { event.preventDefault(); void run(() => api.createTrackingLink({ affiliateOfferId: trackingOfferId, campaignId: trackingCampaignId || undefined, destinationUrl: trackingDestination.trim(), code: trackingCode.trim() || undefined }), () => { setTrackingOfferId(""); setTrackingCampaignId(""); setTrackingDestination(""); setTrackingCode(""); }); }}>
            <select value={trackingOfferId} onChange={(event) => setTrackingOfferId(event.target.value)} required><option value="">Select affiliate offer</option>{affiliateOffers.filter((offer) => offer.status === "active").map((offer) => <option key={offer.id} value={offer.id}>{offer.id.slice(0, 8)} · {offer.commissionRateBps ? `${offer.commissionRateBps / 100}%` : "commission n/a"}</option>)}</select>
            <select value={trackingCampaignId} onChange={(event) => setTrackingCampaignId(event.target.value)}><option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select>
            <input type="url" placeholder="Destination URL" value={trackingDestination} onChange={(event) => setTrackingDestination(event.target.value)} required />
            <input placeholder="Custom code (optional)" value={trackingCode} onChange={(event) => setTrackingCode(event.target.value)} />
            <button type="submit" disabled={busy}>{busy ? "Saving..." : "Create tracking link"}</button>
          </form>}
          <div className="affiliate-list">{trackingLinks.length === 0 ? <p className="empty">No tracking links yet.</p> : trackingLinks.slice(0, 8).map((link) => <div className="affiliate-row" key={link.id}><div><strong>{link.code}</strong><small>{link.destinationUrl}</small></div><div className="affiliate-meta"><span className={`badge ${link.status}`}>{link.status}</span><small>{link.campaignId ? `campaign ${link.campaignId.slice(0, 8)}` : "unassigned"}</small></div></div>)}</div>
        </article>

        <article className="panel" id="content">
          <div className="panel-heading"><div><p className="eyebrow">Publishing</p><h3>Content queue</h3></div><span>{content.length} total</span></div>
          <form className="affiliate-form" onSubmit={(event) => { event.preventDefault(); void run(() => api.createContent({ title: contentTitle.trim(), platform: contentPlatform, contentType: contentType.trim(), campaignId: contentCampaignId || undefined, status: "draft" }), () => { setContentTitle(""); }); }}>
            <input placeholder="Content title" value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} required />
            <select value={contentPlatform} onChange={(event) => setContentPlatform(event.target.value as ContentPlatform)}>{platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select>
            <input placeholder="Content type" value={contentType} onChange={(event) => setContentType(event.target.value)} required />
            <select value={contentCampaignId} onChange={(event) => setContentCampaignId(event.target.value)}><option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select>
            <button type="submit" disabled={busy}>{busy ? "Saving..." : "Add to queue"}</button>
          </form>
          <div className="affiliate-list">{content.length === 0 ? <p className="empty">No content scheduled.</p> : content.slice(0, 8).map((item) => <div className="affiliate-row" key={item.id}><div><strong>{item.title || item.contentType}</strong><small>{item.platform}{item.campaignId ? ` · campaign ${item.campaignId.slice(0, 8)}` : ""}</small></div><span className={`badge ${item.status}`}>{item.status}</span></div>)}</div>
        </article>

        <article className="panel" id="social-accounts">
          <div className="panel-heading"><div><p className="eyebrow">Distribution</p><h3>Social accounts</h3></div><span>{socialAccounts.length} connected</span></div>
          <form className="affiliate-form" onSubmit={(event) => { event.preventDefault(); void run(() => api.createSocialAccount({ platform: accountPlatform.trim(), accountReference: accountReference.trim(), status: "pending" }), () => { setAccountReference(""); }); }}>
            <input placeholder="Platform" value={accountPlatform} onChange={(event) => setAccountPlatform(event.target.value)} required />
            <input placeholder="Account reference" value={accountReference} onChange={(event) => setAccountReference(event.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? "Saving..." : "Register account"}</button>
          </form>
          <div className="affiliate-list">{socialAccounts.length === 0 ? <p className="empty">No social accounts registered.</p> : socialAccounts.map((account) => <div className="affiliate-row" key={account.id}><div><strong>{account.platform}</strong><small>{account.accountReference}</small></div><span className={`badge ${account.status}`}>{account.status}</span></div>)}</div>
          <p className="analytics-note">OAuth credentials remain opaque references; this screen never accepts or displays access tokens.</p>
        </article>
      </div>
    </section>
  );
}
