import { useEffect, useRef, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api, type ProductMediaAssetView, type ProductMediaRightsAuditView, type ProductMediaIdentityAuditView, type ProductMediaRightsBasis } from "../api/client";

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
  const [productsCursor, setProductsCursor] = useState<string | null>(null);
  const [productsHaveMore, setProductsHaveMore] = useState(false);
  const [productId, setProductId] = useState("");
  const [assets, setAssets] = useState<ProductMediaAssetView[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [audits, setAudits] = useState<Record<string, ProductMediaRightsAuditView[]>>({});
  const [identityAudits, setIdentityAudits] = useState<Record<string, ProductMediaIdentityAuditView[]>>({});
  const [identityReasons, setIdentityReasons] = useState<Record<string, string>>({});
  const [generationStyles, setGenerationStyles] = useState<Record<string, "studio" | "lifestyle" | "minimal">>({});
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
      const response = await api.productsPage({ limit: 25 });
      if (!active) return;
      setProducts(response.data);
      setProductsCursor(response.nextCursor);
      setProductsHaveMore(response.hasMore);
      if (response.data[0]) setProductId(response.data[0].id);
    }).catch((requestError: unknown) => {
      if (active) setError(requestError instanceof Error ? requestError.message : "Tidak dapat memeriksa hak akses admin.");
    }).finally(() => { if (active) setCheckingRole(false); });
    return () => { active = false; };
  }, []);

  const loadMoreProducts = async () => { if (!productsCursor) return; try { const page = await api.productsPage({ cursor: productsCursor, limit: 25 }); setProducts((current) => [...current, ...page.data]); setProductsCursor(page.nextCursor); setProductsHaveMore(page.hasMore); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Produk berikutnya gagal dimuat."); } };

  const loadAssets = async (selectedProductId: string) => {
    const requestId = ++requestSequence.current;
    setAssets([]);
    setPreviews({});
    setAudits({});
    setIdentityAudits({});
    if (!selectedProductId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await api.productMediaAssets(selectedProductId);
      if (requestId !== requestSequence.current) return;
      setAssets(response.data);
      const aiAssets = response.data.filter((asset) =>
        asset.sourceProvider === "openai" && asset.sourceUrl.startsWith("generated:openai-image-edit:")
      );
      const [signed, history, identityHistory] = await Promise.all([
        Promise.all(response.data.map(async (asset) => {
          try { return [asset.id, (await api.productMediaPreview(selectedProductId, asset.id)).url] as const; }
          catch { return [asset.id, ""] as const; }
        })),
        Promise.all(response.data.map(async (asset) => {
          try { return [asset.id, (await api.productMediaRightsAudits(selectedProductId, asset.id)).data] as const; }
          catch { return [asset.id, []] as const; }
        })),
        Promise.all(aiAssets.map(async (asset) => {
          try { return [asset.id, (await api.productMediaIdentityAudits(selectedProductId, asset.id)).data] as const; }
          catch { return [asset.id, []] as const; }
        }))
      ]);
      if (requestId !== requestSequence.current) return;
      setPreviews(Object.fromEntries(signed.filter(([, url]) => Boolean(url))));
      setAudits(Object.fromEntries(history));
      setIdentityAudits(Object.fromEntries(identityHistory));
    } catch (requestError) {
      if (requestId === requestSequence.current) setError(requestError instanceof Error ? requestError.message : "Gagal memuat aset media produk.");
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  };

  const selectProduct = (selectedProductId: string) => {
    productSelectionSequence.current += 1;
    requestSequence.current += 1;
    setAssets([]);
    setPreviews({});
    setAudits({});
    setIdentityAudits({});
    setBusyAssetId(null);
    setError(null);
    setNotice(null);
    setProductId(selectedProductId);
  };

  useEffect(() => { if (isAdmin && productId) void loadAssets(productId); }, [isAdmin, productId]);

  const updateForm = (assetId: string, field: keyof ReviewForm, value: string) => {
    setForms((current) => ({ ...current, [assetId]: { ...(current[assetId] ?? initialForm()), [field]: value } }));
  };

  const generateImage = async (asset: ProductMediaAssetView) => {
    if (asset.kind !== "image" || asset.rightsStatus !== "verified" || asset.rightsBasis !== "user_owned") {
      setError("Pembuatan visual AI memerlukan gambar referensi milik sendiri yang hak penggunaannya sudah diverifikasi.");
      return;
    }
    const selectedProductId = productId;
    const selectionRequestId = productSelectionSequence.current;
    const style = generationStyles[asset.id] ?? "studio";
    setBusyAssetId(asset.id); setError(null); setNotice(null);
    try {
      const result = await api.generateProductImage(selectedProductId, asset.id, style);
      if (selectionRequestId !== productSelectionSequence.current) return;
      if (!result.asset) throw new Error(result.reason ?? "Generator AI tidak menghasilkan aset gambar.");
      setNotice("Visual AI tersimpan sebagai aset baru. Status identitas masih pending dan belum dapat digunakan untuk video atau publikasi.");
      await loadAssets(selectedProductId);
    } catch (requestError) {
      if (selectionRequestId === productSelectionSequence.current) setError(requestError instanceof Error ? requestError.message : "Pembuatan visual AI gagal. Pastikan layanan OpenAI Staging telah dikonfigurasi.");
    } finally { if (selectionRequestId === productSelectionSequence.current) setBusyAssetId(null); }
  };

  const reviewIdentity = async (asset: ProductMediaAssetView, status: "verified" | "rejected") => {
    const selectedProductId = productId;
    const selectionRequestId = productSelectionSequence.current;
    const reason = (identityReasons[asset.id] ?? "").trim();
    if (!reason) { setError("Tuliskan hasil perbandingan bentuk, warna, logo, kemasan, dan detail produk sebelum memberi keputusan."); return; }
    setBusyAssetId(asset.id); setError(null); setNotice(null);
    try {
      await api.reviewProductMediaIdentity(selectedProductId, asset.id, { status, reason });
      if (selectionRequestId !== productSelectionSequence.current) return;
      setNotice(status === "verified"
        ? "Identitas visual disetujui dan dicatat dalam audit. Hak penggunaan tetap harus diverifikasi secara terpisah."
        : "Visual AI ditolak dan dicatat dalam audit. Aset ini tetap tidak layak untuk publikasi.");
      await loadAssets(selectedProductId);
    } catch (requestError) {
      if (selectionRequestId === productSelectionSequence.current) setError(requestError instanceof Error ? requestError.message : "Review identitas produk gagal.");
    } finally { if (selectionRequestId === productSelectionSequence.current) setBusyAssetId(null); }
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
      <p className="analytics-note">Untuk gambar AI, bandingkan hasil dengan foto referensi asli. Persetujuan identitas dan persetujuan hak penggunaan adalah dua pemeriksaan terpisah. Generator hanya aktif setelah konfigurasi OpenAI Staging tersedia.</p>
      <div className="affiliate-form">
        <label htmlFor="product-media-rights-product">Produk</label>
        <select id="product-media-rights-product" value={productId} onChange={(event) => selectProduct(event.target.value)}>
          <option value="">Pilih produk</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
        {productsHaveMore && <button type="button" className="secondary-button" onClick={() => void loadMoreProducts()}>Muat 25 produk berikutnya</button>}
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
                  : <span>Preview privat tidak tersedia</span>}
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
                <details className="product-media-rights-history">
                  <summary>Riwayat pemeriksaan ({(audits[asset.id] ?? []).length})</summary>
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
                {asset.kind === "image" && asset.sourceProvider !== "openai" && asset.rightsStatus === "verified" && asset.rightsBasis === "user_owned" && (
                  <div className="affiliate-form product-ai-generate">
                    <strong>Buat visual promosi dengan AI</strong>
                    <small>Foto ini menjadi referensi asli. AI hanya diminta mengubah latar dan komposisi; hasil tetap wajib diperiksa sebelum digunakan.</small>
                    <label htmlFor={"ai-image-style-" + asset.id}>Gaya visual</label>
                    <select id={"ai-image-style-" + asset.id} value={generationStyles[asset.id] ?? "studio"} onChange={(event) => setGenerationStyles((current) => ({ ...current, [asset.id]: event.target.value as "studio" | "lifestyle" | "minimal" }))} disabled={Boolean(busyAssetId)}>
                      <option value="studio">Studio profesional</option>
                      <option value="lifestyle">Lifestyle</option>
                      <option value="minimal">Minimalis</option>
                    </select>
                    <button type="button" onClick={() => void generateImage(asset)} disabled={Boolean(busyAssetId)}>{busyAssetId === asset.id ? "Membuat visual…" : "Buat visual AI dari foto ini"}</button>
                  </div>
                )}
                {asset.sourceProvider === "openai" && asset.sourceUrl.startsWith("generated:openai-image-edit:") && (() => {
                  const referenceId = asset.sourceUrl.slice("generated:openai-image-edit:".length);
                  const reference = assets.find((item) => item.id === referenceId);
                  const referencePreview = previews[referenceId];
                  const history = identityAudits[asset.id] ?? [];
                  const identityStatus = asset.identityStatus ?? "pending";
                  return (
                    <div className="product-media-identity-review">
                      <div className="panel-heading">
                        <div><p className="eyebrow">Pemeriksaan kesetiaan produk</p><h4>Referensi asli vs hasil AI</h4></div>
                        <span className={"badge " + (identityStatus === "verified" ? "active" : identityStatus === "rejected" ? "inactive" : "")}>{identityStatus}</span>
                      </div>
                      <div className="product-media-identity-compare">
                        <figure>
                          <figcaption>Foto referensi asli</figcaption>
                          {referencePreview ? <img src={referencePreview} alt="Foto referensi produk asli" /> : <span>Referensi tidak tersedia</span>}
                          <small>{reference ? reference.id.slice(0, 8) : referenceId.slice(0, 8)}</small>
                        </figure>
                        <figure>
                          <figcaption>Visual hasil AI</figcaption>
                          {preview ? <img src={preview} alt="Visual produk hasil AI" /> : <span>Preview tidak tersedia</span>}
                          <small>{asset.id.slice(0, 8)}</small>
                        </figure>
                      </div>
                      <p className="analytics-note">Pastikan siluet, proporsi, warna, bahan, komponen, logo, tulisan, label, dan kemasan tetap sesuai foto asli. Tolak jika AI mengubah atau mengarang detail produk.</p>
                      {asset.identityStatus === "verified" && <p className="analytics-note">Diperiksa oleh {asset.identityReviewedBy ?? "admin"} · {asset.identityReviewedAt ? new Date(asset.identityReviewedAt).toLocaleString("id-ID") : "—"} · {asset.identityReviewReason}</p>}
                      <label htmlFor={"identity-reason-" + asset.id}>Alasan / hasil perbandingan</label>
                      <textarea id={"identity-reason-" + asset.id} rows={3} maxLength={1000} value={identityReasons[asset.id] ?? ""} onChange={(event) => setIdentityReasons((current) => ({ ...current, [asset.id]: event.target.value }))} placeholder="Contoh: bentuk, warna, logo, dan kemasan sama dengan referensi." disabled={Boolean(busyAssetId)} />
                      <div className="product-media-rights-actions">
                        <button type="button" onClick={() => void reviewIdentity(asset, "verified")} disabled={Boolean(busyAssetId) || identityStatus === "verified" || !(identityReasons[asset.id] ?? "").trim()}>{busyAssetId === asset.id ? "Menyimpan…" : "Setujui identitas"}</button>
                        <button type="button" className="secondary-button" onClick={() => void reviewIdentity(asset, "rejected")} disabled={Boolean(busyAssetId) || identityStatus === "rejected" || !(identityReasons[asset.id] ?? "").trim()}>Tolak visual AI</button>
                      </div>
                      <details className="product-media-rights-history">
                        <summary>Riwayat review identitas ({history.length})</summary>
                        {history.length === 0 ? <p className="analytics-note">Belum ada pemeriksaan identitas.</p> : <ol>{history.map((entry) => (
                          <li key={entry.id}>
                            <strong>{entry.action === "verify" ? "Disetujui" : "Ditolak"} · {entry.previousIdentityStatus} → {entry.newIdentityStatus}</strong>
                            <small>{new Date(entry.createdAt).toLocaleString("id-ID")} · {entry.actorId}</small>
                            <p>{entry.reason}</p>
                          </li>
                        ))}</ol>}
                      </details>
                    </div>
                  );
                })()}
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
