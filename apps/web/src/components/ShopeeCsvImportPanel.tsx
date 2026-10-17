import { useState } from "react";
import type { Affiliate } from "@affiliateos/shared";
import { api } from "../api/client";

type ImportSummary = {
  importedProducts: number;
  importedOffers: number;
  skippedItems: number;
  affiliateOfferIds: string[];
};

type CsvIssue = { row: number; message: string };

type ApiErrorWithDetails = Error & { details?: { errors?: CsvIssue[]; validRows?: number } };

type Props = {
  affiliates: Affiliate[];
  onImported: () => Promise<void>;
};

const MAX_CSV_BYTES = 450 * 1024;

export function ShopeeCsvImportPanel({ affiliates, onImported }: Props) {
  const [affiliateId, setAffiliateId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<CsvIssue[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const selectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    setError(null);
    setIssues([]);
    setSummary(null);
    setCsv("");
    setFileName("");
    setFileSize(0);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Pilih file dengan ekstensi .csv.");
      event.currentTarget.value = "";
      return;
    }
    if (file.size === 0 || file.size > MAX_CSV_BYTES) {
      setError("Ukuran file harus lebih dari 0 byte dan maksimal 450 KiB agar aman terhadap overhead JSON.");
      event.currentTarget.value = "";
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error("File CSV kosong.");
      setCsv(text);
      setFileName(file.name);
      setFileSize(file.size);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "File CSV tidak dapat dibaca.");
    }
  };

  const importCsv = async () => {
    if (!affiliateId || !csv || !fileName) {
      setError("Pilih affiliate dan file CSV terlebih dahulu.");
      return;
    }
    const confirmed = window.confirm(
      `Impor file "${fileName}" ke AffiliateOS? Pastikan file berasal dari akun Shopee Affiliate yang benar. Data akan disimpan ke katalog dan offer affiliate.`
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setIssues([]);
    setSummary(null);
    try {
      const result = await api.importShopeeAffiliateCsv({
        affiliateId,
        csv,
        sourceReference: fileName
      });
      setSummary({
        importedProducts: result.importedProducts,
        importedOffers: result.importedOffers,
        skippedItems: result.skippedItems,
        affiliateOfferIds: result.affiliateOfferIds
      });
      setCsv("");
      setFileName("");
      setFileSize(0);
      const input = document.getElementById("shopee-csv-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await onImported();
    } catch (requestError) {
      const apiError = requestError as ApiErrorWithDetails;
      setError(apiError instanceof Error ? apiError.message : "Impor CSV Shopee gagal.");
      setIssues(apiError.details?.errors ?? []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="panel shopee-import-panel" id="shopee-csv-import">
      <div className="panel-heading">
        <div><p className="eyebrow">Impor manual</p><h3>CSV Shopee Affiliate</h3></div>
        <span className="badge">Operator</span>
      </div>
      <p>Unggah file CSV yang benar-benar tersedia di akun Shopee Affiliate Anda. Fitur ini tidak memerlukan Open API, App ID/Secret, menu Kreatif, atau Product Feed.</p>
      <div className="affiliate-form">
        <label htmlFor="shopee-csv-affiliate">Pemilik akun affiliate</label>
        <select id="shopee-csv-affiliate" value={affiliateId} onChange={(event) => setAffiliateId(event.target.value)} disabled={busy} required>
          <option value="">Pilih affiliate yang sudah terdaftar</option>
          {affiliates.map((affiliate) => <option key={affiliate.id} value={affiliate.id}>{affiliate.name} · {affiliate.email}</option>)}
        </select>
        <label htmlFor="shopee-csv-file">File CSV dari Shopee Affiliate</label>
        <input id="shopee-csv-file" type="file" accept=".csv,text/csv" onChange={(event) => void selectFile(event)} disabled={busy} />
        {fileName && <div className="shopee-file-summary"><strong>{fileName}</strong><small>{fileSize.toLocaleString("id-ID")} byte · batas 450 KiB</small></div>}
        <button type="button" onClick={() => void importCsv()} disabled={busy || !affiliateId || !csv || !fileName || affiliates.length === 0}>
          {busy ? "Memvalidasi dan mengimpor…" : "Validasi & impor CSV"}
        </button>
      </div>
      <p className="shopee-import-note">Seluruh file divalidasi sebelum penulisan. Jika ada baris tidak valid, impor ditolak dan tidak boleh dianggap berhasil sebagian. Impor ulang file yang sama dirancang agar tidak menggandakan produk atau offer.</p>
      {error && <div className="shopee-import-error" role="alert"><strong>Impor belum berhasil</strong><p>{error}</p>{issues.length > 0 && <ul>{issues.map((issue, index) => <li key={`${issue.row}-${index}`}>Baris {issue.row}: {issue.message}</li>)}</ul>}</div>}
      {summary && <div className="shopee-import-success" role="status"><strong>Impor selesai</strong><div className="shopee-import-counts"><span>Produk diproses <b>{summary.importedProducts}</b></span><span>Offer diproses <b>{summary.importedOffers}</b></span><span>Dilewati <b>{summary.skippedItems}</b></span></div><small>Data dashboard telah dimuat ulang. Tetap tinjau tautan dan kelayakan offer sebelum promosi.</small></div>}
      {affiliates.length === 0 && <p className="shopee-import-note">Buat record affiliate terlebih dahulu sebelum mengimpor CSV.</p>}
    </article>
  );
}
