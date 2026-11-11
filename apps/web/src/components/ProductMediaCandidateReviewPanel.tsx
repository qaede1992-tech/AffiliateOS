import { useEffect, useRef, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api, type ProductMediaCandidateView, type ProductMediaCandidateReviewAuditView } from "../api/client";

type CandidateStatus = "pending" | "approved";
type AuditMap = Record<string, ProductMediaCandidateReviewAuditView[]>;

export function ProductMediaCandidateReviewPanel() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingRole, setCheckingRole] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [status, setStatus] = useState<CandidateStatus>("pending");
  const [candidates, setCandidates] = useState<ProductMediaCandidateView[]>([]);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [audits, setAudits] = useState<AuditMap>({});
  const [auditLoadingIds, setAuditLoadingIds] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    api.me().then(async (user) => {
      if (!active) return;
      if (user.role !== "admin") return;
      setIsAdmin(true);
      const response = await api.products();
      if (!active) return;
      setProducts(response.data);
      setProductId(response.data[0]?.id ?? "");
    }).catch((requestError: unknown) => {
      if (active) setError(requestError instanceof Error ? requestError.message : "Hak akses admin tidak dapat diverifikasi.");
    }).finally(() => { if (active) setCheckingRole(false); });
    return () => { active = false; };
  }, []);

  const loadCandidates = async (selectedProductId: string, selectedStatus: CandidateStatus) => {
    const requestId = ++sequence.current;
    if (!selectedProductId) {
      setCandidates([]);
      setImportedIds(new Set());
      setAudits({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setCandidates([]);
    setAudits({});
    setAuditLoadingIds(new Set());
    try {
      const [candidateResponse, assetResponse] = await Promise.all([
        api.productMediaCandidates(selectedProductId, selectedStatus),
        api.productMediaAssets(selectedProductId)
      ]);
      if (requestId !== sequence.current) return;
      setCandidates(candidateResponse.data);
      setImportedIds(new Set(assetResponse.data.flatMap((asset) => asset.sourceCandidateId ? [asset.sourceCandidateId] : [])));
      // Candidate audit histories are loaded on demand when an approved
      // candidate's history is expanded, rather than issuing one request per
      // candidate when switching the tab.
      setAudits({});
      setAuditLoadingIds(new Set());
    } catch (requestError) {
      if (requestId === sequence.current) setError(requestError instanceof Error ? requestError.message : "Kandidat media tidak dapat dimuat.");
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin && productId) void loadCandidates(productId, status);
  }, [isAdmin, productId, status]);

  const loadCandidateAudit = async (candidate: ProductMediaCandidateView) => {
    if (Object.prototype.hasOwnProperty.call(audits, candidate.id) || auditLoadingIds.has(candidate.id)) return;
    const selectedProductId = productId;
    const requestId = sequence.current;
    setAuditLoadingIds((current) => new Set(current).add(candidate.id));
    try {
      const response = await api.productMediaCandidateReviewAudits(selectedProductId, candidate.id);
      if (requestId !== sequence.current) return;
      setAudits((current) => ({ ...current, [candidate.id]: response.data }));
    } catch (requestError) {
      // Do not cache a failed request as an empty history; reopening the
      // disclosure should be able to retry the audit read.
      if (requestId === sequence.current) {
        setError(requestError instanceof Error ? requestError.message : "Riwayat review kandidat tidak dapat dimuat.");
      }
    } finally {
      if (requestId === sequence.current) {
        setAuditLoadingIds((current) => { const next = new Set(current); next.delete(candidate.id); return next; });
      }
    }
  };

  const reviewCandidate = async (candidate: ProductMediaCandidateView, decision: "approved" | "rejected") => {
    const reason = reasons[candidate.id]?.trim() ?? "";
    if (!reason) {
      setError("Tuliskan alasan review sebelum menyetujui atau menolak kandidat.");
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    setNotice(null);
    try {
      await api.reviewProductMediaCandidate(productId, candidate.id, { status: decision, reason });
      setReasons((current) => ({ ...current, [candidate.id]: "" }));
      setNotice(decision === "approved" ? "Kandidat disetujui. Buka tab Disetujui untuk mengimpor media." : "Kandidat ditolak dan dicatat dalam audit.");
      if (decision === "approved") setStatus("approved");
      else await loadCandidates(productId, "pending");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Keputusan review tidak dapat disimpan.");
    } finally {
      setBusyId(null);
    }
  };

  const importCandidate = async (candidate: ProductMediaCandidateView) => {
    setBusyId(candidate.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.importProductMediaCandidate(productId, candidate.id);
      setImportedIds((current) => new Set(current).add(candidate.id));
      setNotice(result.alreadyImported
        ? "Media kandidat ini sudah pernah diimpor. Aset yang sama digunakan kembali."
        : "Media berhasil diimpor. Status hak publikasinya tetap belum terverifikasi.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Media kandidat tidak dapat diimpor.");
    } finally {
      setBusyId(null);
    }
  };

  if (checkingRole) return <section className="panel"><p>Memeriksa akses administrator…</p></section>;
  if (!isAdmin) return null;

  return (
    <section className="panel product-media-candidate-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Product media governance</p><h3>Review kandidat media</h3></div>
        <span>{candidates.length} kandidat</span>
      </div>
      <p className="analytics-note">Persetujuan hanya memeriksa kecocokan identitas kandidat. Hak publikasi tetap harus diverifikasi secara terpisah.</p>
      <div className="product-media-candidate-toolbar">
        <label>
          Produk
          <select aria-label="Pilih produk untuk review media" value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">Pilih produk</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <div className="product-media-candidate-tabs" role="tablist" aria-label="Status kandidat media">
          <button type="button" role="tab" aria-selected={status === "pending"} className={status === "pending" ? "active" : ""} onClick={() => setStatus("pending")}>Menunggu review</button>
          <button type="button" role="tab" aria-selected={status === "approved"} className={status === "approved" ? "active" : ""} onClick={() => setStatus("approved")}>Disetujui</button>
        </div>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {notice && <p className="success-message" role="status">{notice}</p>}
      {loading ? <p className="empty">Memuat kandidat media…</p> : !productId ? <p className="empty">Belum ada produk yang dapat ditinjau.</p> : candidates.length === 0 ? (
        <p className="empty">{status === "pending" ? "Tidak ada kandidat yang menunggu review." : "Belum ada kandidat yang disetujui untuk diimpor."}</p>
      ) : (
        <div className="product-media-candidate-list">
          {candidates.map((candidate) => {
            const alreadyImported = importedIds.has(candidate.id);
            const candidateAudits = audits[candidate.id] ?? [];
            const hasLoadedAudits = Object.prototype.hasOwnProperty.call(audits, candidate.id);
            const latestAudit = candidateAudits[0];
            return (
              <article className="product-media-candidate-card" key={candidate.id}>
                <div className="product-media-candidate-preview">
                  <img src={candidate.imageUrl} alt={candidate.title} loading="lazy" referrerPolicy="no-referrer" />
                </div>
                <div className="product-media-candidate-content">
                  <div className="product-media-candidate-title-row">
                    <h4>{candidate.title}</h4>
                    <span className={candidate.identityScore >= 80 ? "candidate-score strong" : "candidate-score"}>{candidate.identityScore}/100</span>
                  </div>
                  <p className="candidate-meta">{candidate.provider.replaceAll("_", " ")} · {candidate.identityStatus === "strong_match" ? "Kecocokan kuat" : "Perlu review"}</p>
                  <p>{candidate.identityReasons.join(" · ") || "Tidak ada alasan tambahan dari proses pencarian."}</p>
                  <div className="candidate-source-details">
                    <span>Lisensi: {candidate.license ? `${candidate.license}${candidate.licenseVersion ? ` ${candidate.licenseVersion}` : ""}` : "Belum diketahui"}</span>
                    <span>Pencipta: {candidate.creator ?? "Tidak dicantumkan"}</span>
                    {candidate.sourcePublisher && <span>Penerbit: {candidate.sourcePublisher}</span>}
                  </div>
                  <a href={candidate.landingPageUrl} target="_blank" rel="noreferrer">Buka halaman sumber</a>
                  {candidate.licenseUrl && <a href={candidate.licenseUrl} target="_blank" rel="noreferrer">Periksa teks lisensi</a>}
                  {status === "approved" && <details className="product-media-candidate-history" onToggle={(event) => {
                    if (event.currentTarget.open) void loadCandidateAudit(candidate);
                  }}>
                    <summary>Riwayat review{hasLoadedAudits ? ` (${candidateAudits.length})` : ""}</summary>
                    {auditLoadingIds.has(candidate.id) ? <p className="analytics-note">Memuat riwayat review…</p>
                      : !hasLoadedAudits ? <p className="analytics-note">Buka bagian ini untuk memuat riwayat review.</p>
                      : candidateAudits.length === 0 ? <p className="analytics-note">Belum ada catatan review.</p>
                      : candidateAudits.map((audit) => <p className="candidate-review-audit" key={audit.id}>Review oleh {audit.actorId}: {audit.reason}</p>)}
                  </details>}
                  {status === "pending" && latestAudit && <p className="candidate-review-audit">Review oleh {latestAudit.actorId}: {latestAudit.reason}</p>}
                  {status === "pending" ? (
                    <div className="candidate-review-actions">
                      <input
                        aria-label={`Alasan review ${candidate.title}`}
                        value={reasons[candidate.id] ?? ""}
                        onChange={(event) => setReasons((current) => ({ ...current, [candidate.id]: event.target.value }))}
                        placeholder="Alasan review wajib diisi"
                        maxLength={1000}
                      />
                      <div>
                        <button type="button" onClick={() => void reviewCandidate(candidate, "approved")} disabled={busyId === candidate.id || !reasons[candidate.id]?.trim()}>Setujui</button>
                        <button type="button" className="secondary-button" onClick={() => void reviewCandidate(candidate, "rejected")} disabled={busyId === candidate.id || !reasons[candidate.id]?.trim()}>Tolak</button>
                      </div>
                    </div>
                  ) : (
                    <div className="candidate-import-actions">
                      <span className={alreadyImported ? "candidate-import-status complete" : "candidate-import-status"}>{alreadyImported ? "Sudah diimpor" : "Belum diimpor"}</span>
                      <button type="button" onClick={() => void importCandidate(candidate)} disabled={busyId === candidate.id || alreadyImported}>
                        {busyId === candidate.id ? "Memproses…" : alreadyImported ? "Aset tersimpan" : "Impor media"}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
