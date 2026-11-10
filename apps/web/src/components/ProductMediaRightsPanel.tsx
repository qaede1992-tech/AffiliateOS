import { useEffect, useRef, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api, type ProductMediaAssetView, type ProductMediaRightsAuditView, type ProductMediaRightsBasis } from "../api/client";

type ReviewForm = { rightsBasis: ProductMediaRightsBasis; rightsEvidenceUrl: string; sourcePublisher: string; reason: string };
const basisOptions: Array<{ value: ProductMediaRightsBasis; label: string }> = [
  { value: "explicit_permission", label: "Izin tertulis eksplisit" },
  { value: "license", label: "Lisensi" },
  { value: "public_domain", label: "Domain publik" },
  { value: "user_owned", label: "Milik sendiri" },
  { value: "platform_authorization", label: "Otorisasi platform" }
];
const initialForm = (): ReviewForm => ({ rightsBasis: "explicit_permission", rightsEvidenceUrl: "", sourcePublisher: "", reason: "" });
const safeEvidenceUrl = (value: string | null): string | undefined => { try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; } };

export function ProductMediaRightsPanel() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingRole, setCheckingRole] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [assets, setAssets] = useState<ProductMediaAssetView[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [audits, setAudits] = useState<Record<string, ProductMediaRightsAuditView[]>>({});
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({});
  const [auditLoading, setAuditLoading] = useState<Record<string, boolean>>({});
  const [forms, setForms] = useState<Record<string, ReviewForm>>({});
  const [loading, setLoading] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const productSelectionSequence = useRef(0);

  useEffect(() => {
    let active = true;
    api.me().then(async (user) => {
      if (!active) return;
      if (user.role !== "admin") return;
      setIsAdmin(true);
      const response = await api.products();
      if (!active) return;
      setProducts(response.data);
      if (response.data[0]) setProductId(response.data[0].id);
    }).catch((requestError: unknown) => {
      if (active) setError(requestError instanceof Error ? requestError.message : "Tidak dapat memeriksa hak akses admin.");
    }).finally(() => { if (active) setCheckingRole(false); });
    return () => { active = false; };
  }, []);

  const loadAssets = async (selectedProductId: string) => {
    const requestId = ++requestSequence.current;
    setAssets([]);
    setPreviews({});
    setAudits({});
    setPreviewLoading({});
    setAuditLoading({});
    if (!selectedProductId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await api.productMediaAssets(selectedProductId);
      if (requestId !== requestSequence.current) return;
      setAssets(response.data);
      // Signed preview URLs and audit histories are loaded only when the admin asks to view them.
      // This avoids N+N requests when a product contains many media assets.
    } catch (requestError) {
      if (requestId === requestSequence.current) setError(requestError instanceof Error ? requestError.message : "Gagal memuat aset media produk.");
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  };

  const loadPreview = async (assetId: string) => {
    if (previews[assetId] || previewLoading[assetId]) return;
    const selectedProductId = productId;
    const requestId = requestSequence.current;
    setPreviewLoading((current) => ({ ...current, [assetId]: true }));
    try {
      const response = await api.productMediaPreview(selectedProductId, assetId);
      if (requestId === requestSequence.current) setPreviews((current) => ({ ...current, [assetId]: response.url }));
    } catch {
      if (requestId === requestSequence.current) setError("Preview privat tidak dapat dimuat. Coba lagi.");
    } finally {
      if (requestId === requestSequence.current) setPreviewLoading((current) => ({ ...current, [assetId]: false }));
    }
  };

  const loadAudit = async (assetId: string) => {
    if (Object.prototype.hasOwnProperty.call(audits, assetId) || auditLoading[assetId]) return;
    const selectedProductId = productId;
    const requestId = requestSequence.current;
    setAuditLoading((current) => ({ ...current, [assetId]: true }));
    try {
      const response = await api.productMediaRightsAudits(selectedProductId, assetId);
      if (requestId === requestSequence.current) setAudits((current) => ({ ...current, [assetId]: response.data }));
    } catch {
      if (requestId === requestSequence.current) setError("Riwayat audit tidak dapat dimuat. Buka kembali bagian riwayat untuk mencoba lagi.");
    } finally {
      if (requestId === requestSequence.current) setAuditLoading((current) => ({ ...current, [assetId]: false }));
    }
  };

  const selectProduct = (selectedProductId: string) => {
    productSelectionSequence.current += 1;
    requestSequence.current += 1;
    setAssets([]);
    setPreviews({});
    setAudits({});
    setPreviewLoading({});
    setAuditLoading({});
    setBusyAssetId(null);
    setError(null);
    setNotice(null);
    setProductId(selectedProductId);
  };

  useEffect(() => { if (isAdmin && productId) void loadAssets(productId); }, [isAdmin, productId]);

  const updateForm = (assetId: string, field: keyof ReviewForm, value: string) => {
    setForms((current) => ({ ...current, [assetId]: { ...(current[assetId] ?? initialForm()), [field]: value } }));
  };

  const verify = async (asset: ProductMediaAssetView) => {
    const selectedProductId = productId;
    const selectionRequestId = productSelectionSequence.current;
    const form = forms[asset.id] ?? initialForm();
    if (!form.rightsEvidenceUrl.trim() || !form.sourcePublisher.trim() || !form.reason.trim()) {
      setError("Lengkapi URL bukti HTTPS, pemilik/penerbit media, dan alasan pemeriksaan.");
      return;
    }
    setBusyAssetId(asset.id); setError(null); setNotice(null);
    try {
      await api.reviewProductMediaRights(selectedProductId, asset.id, {
        status: "verified", rightsBasis: form.rightsBasis, rightsEvidenceUrl: form.rightsEvidenceUrl.trim(),
        sourcePublisher: form.sourcePublisher.trim(), reason: form.reason.trim()
      });
      if (selectionRequestId !== productSelectionSequence.current) return;
      setNotice("Hak media berhasil diverifikasi dan dicatat dalam audit.");
      await loadAssets(selectedProductId);
    } catch (requestError) {
      if (selectionRequestId === productSelectionSequence.current) setError(requestError instanceof Error ? requestError.message : "Verifikasi hak media gagal.");
    } finally { if (selectionRequestId === productSelectionSequence.current) setBusyAssetId(null); }
  };

  const revoke = async (asset: ProductMediaAssetView) => {
    const selectedProductId = productId;
    const selectionRequestId = productSelectionSequence.current;
    const reason = (forms[asset.id] ?? initialForm()).reason.trim();
    if (!reason) { setError("Isi alasan pencabutan hak media terlebih dahulu."); return; }
    if (!window.confirm("Cabut status hak media ini? Media tidak akan lolos gerbang publikasi produk.")) return;
    setBusyAssetId(asset.id); setError(null); setNotice(null);
    try {
      await api.reviewProductMediaRights(selectedProductId, asset.id, { status: "revoked", reason });
      if (selectionRequestId !== productSelectionSequence.current) return;
      setNotice("Status hak media dicabut dan dicatat dalam audit.");
      await loadAssets(selectedProductId);
    } catch (requestError) {
      if (selectionRequestId === productSelectionSequence.current) setError(requestError instanceof Error ? requestError.message : "Pencabutan hak media gagal.");
    } finally { if (selectionRequestId === productSelectionSequence.current) setBusyAssetId(null); }
  };

  if (checkingRole) return <section className="analytics-section"><p className="empty">Memeriksa akses admin…</p></section>;
  if (!isAdmin) return null;

  return (
    <section className="analytics-section" id="product-media-rights">
      <div className="section-heading">
        <div><p className="eyebrow">Kontrol hak penggunaan</p><h2>Review media produk</h2></div>
        <span>Khusus admin</span>
      </div>
      <p className="analytics-note">Periksa aset yang tersimpan di bucket privat sebelum memberi izin publikasi. Verifikasi memerlukan bukti hak yang benar-benar diperiksa; URL bukti saja tidak otomatis membuktikan kepemilikan atau lisensi.</p>
      <div className="affiliate-form">
        <label htmlFor="product-media-rights-product">Produk</label>
        <select id="product-media-rights-product" value={productId} onChange={(event) => selectProduct(event.target.value)}>
          <option value="">Pilih produk</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
        <button type="button" onClick={() => void loadAssets(productId)} disabled={!productId || loading || Boolean(busyAssetId)}>Muat ulang aset</button>
      </div>
      {loading && <p className="empty">Memuat media dan preview privat…</p>}
      {!loading && productId && assets.length === 0 && <p className="empty">Belum ada aset media tersimpan untuk produk ini.</p>}
      <div className="product-media-rights-list">
        {assets.map((asset) => {
          const form = forms[asset.id] ?? initialForm();
          const preview = previews[asset.id];
          return (
            <article className="product-media-rights-item" key={asset.id}>
              <div className="product-media-rights-preview">
                {preview ? asset.kind === "video"
                  ? <video src={preview} controls preload="metadata" />
                  : <img src={preview} alt={`Media produk ${asset.productId}`} />
                  : <div><span>Preview privat belum dimuat</span><button type="button" onClick={() => void loadPreview(asset.id)} disabled={Boolean(previewLoading[asset.id])}>{previewLoading[asset.id] ? "Memuat preview…" : "Muat preview privat"}</button></div>}
              </div>
              <div className="product-media-rights-details">
                <div className="panel-heading">
                  <div><p className="eyebrow">{asset.kind} · {asset.mimeType}</p><h3>{asset.id.slice(0, 8)}</h3></div>
                  <span className={`badge ${asset.rightsStatus === "verified" ? "active" : "inactive"}`}>{asset.rightsStatus}</span>
                </div>
                <small>{(asset.byteSize / 1024).toFixed(1)} KiB · SHA-256 {asset.sha256.slice(0, 16)}…</small>
                <p className="analytics-note">
                  Metadata teknis: {asset.width && asset.height ? `${asset.width} × ${asset.height} px` : "dimensi belum diketahui"}
                  {asset.durationMs != null ? ` · ${(asset.durationMs / 1000).toFixed(2)} detik` : ""}
                  {asset.kind === "video" ? ` · audio: ${asset.hasAudio == null ? "belum diketahui" : asset.hasAudio ? "ada" : "tidak terdeteksi"}` : ""}
                </p>
                <div className="product-media-readiness">
                  {(["instagram", "tiktok"] as const).map((platform) => {
                    const readiness = asset.technicalReadiness[platform];
                    const label = readiness.status === "ready" ? "Sesuai metadata" : readiness.status === "not_ready" ? "Tidak sesuai" : "Perlu pemeriksaan";
                    return <details key={platform}>
                      <summary>{platform === "instagram" ? "Instagram" : "TikTok"}: {label}</summary>
                      <ul>{readiness.checks.map((item) => <li key={item.key}>
                        <strong>{item.status === "pass" ? "Lulus" : item.status === "fail" ? "Gagal" : "Belum diketahui"}:</strong> {item.detail}
                      </li>)}</ul>
                      {readiness.limitations.map((item) => <small key={item}>{item}</small>)}
                    </details>;
                  })}
                </div>
                <small className="analytics-note">Penilaian ini hanya preflight teknis berdasarkan metadata tersimpan. Ini bukan persetujuan hak media atau izin publikasi; codec, frame rate, dan batas akun tertentu mungkin masih perlu diperiksa.</small>
                {asset.rightsStatus === "verified" && <p className="analytics-note">Dasar: {asset.rightsBasis} · Penerbit: {asset.sourcePublisher} · Diverifikasi: {asset.rightsVerifiedAt ? new Date(asset.rightsVerifiedAt).toLocaleString("id-ID") : "—"}</p>}
                {safeEvidenceUrl(asset.rightsEvidenceUrl) && <p><a href={safeEvidenceUrl(asset.rightsEvidenceUrl)} target="_blank" rel="noreferrer">Buka bukti hak yang tercatat</a></p>}
                <details className="product-media-rights-history" onToggle={(event) => { if (event.currentTarget.open) void loadAudit(asset.id); }}>
                  <summary>Riwayat pemeriksaan {auditLoading[asset.id] ? "(memuat…)" : Object.prototype.hasOwnProperty.call(audits, asset.id) ? `(${(audits[asset.id] ?? []).length})` : "(belum dimuat)"}</summary>
                  {(audits[asset.id] ?? []).length === 0
                    ? <p className="analytics-note">Belum ada catatan perubahan hak.</p>
                    : <ol>
                        {(audits[asset.id] ?? []).map((entry) => (
                          <li key={entry.id}>
                            <strong>{entry.action === "verify" ? "Verifikasi" : "Pencabutan"} · {entry.previousRightsStatus} → {entry.newRightsStatus}</strong>
                            <small>{new Date(entry.createdAt).toLocaleString("id-ID")} · {entry.actorId} ({entry.actorRole})</small>
                            <p>{entry.reason}</p>
                            {entry.rightsBasis && <small>Dasar: {entry.rightsBasis} · Penerbit: {entry.sourcePublisher ?? "—"}</small>}
                            {safeEvidenceUrl(entry.rightsEvidenceUrl) && <a href={safeEvidenceUrl(entry.rightsEvidenceUrl)} target="_blank" rel="noreferrer">Bukti pada saat pemeriksaan</a>}
                          </li>
                        ))}
                      </ol>}
                </details>
                <div className="affiliate-form">
                  <label htmlFor={`rights-basis-${asset.id}`}>Dasar hak</label>
                  <select id={`rights-basis-${asset.id}`} value={form.rightsBasis} onChange={(event) => updateForm(asset.id, "rightsBasis", event.target.value)} disabled={busyAssetId === asset.id}>
                    {basisOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <label htmlFor={`rights-evidence-${asset.id}`}>URL bukti (HTTPS)</label>
                  <input id={`rights-evidence-${asset.id}`} type="url" value={form.rightsEvidenceUrl} onChange={(event) => updateForm(asset.id, "rightsEvidenceUrl", event.target.value)} placeholder="https://…" disabled={busyAssetId === asset.id} />
                  <label htmlFor={`rights-publisher-${asset.id}`}>Pemilik / penerbit media</label>
                  <input id={`rights-publisher-${asset.id}`} value={form.sourcePublisher} onChange={(event) => updateForm(asset.id, "sourcePublisher", event.target.value)} disabled={busyAssetId === asset.id} />
                  <label htmlFor={`rights-reason-${asset.id}`}>Alasan pemeriksaan / pencabutan</label>
                  <textarea id={`rights-reason-${asset.id}`} value={form.reason} onChange={(event) => updateForm(asset.id, "reason", event.target.value)} rows={2} disabled={busyAssetId === asset.id} />
                  <div className="product-media-rights-actions">
                    <button type="button" onClick={() => void verify(asset)} disabled={Boolean(busyAssetId) || asset.rightsStatus === "verified"}>{busyAssetId === asset.id ? "Menyimpan…" : "Verifikasi hak"}</button>
                    {asset.rightsStatus !== "revoked" && <button type="button" className="secondary-button" onClick={() => void revoke(asset)} disabled={Boolean(busyAssetId)}>Cabut hak</button>}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {notice && <p className="shopee-import-success" role="status">{notice}</p>}
    </section>
  );
}
