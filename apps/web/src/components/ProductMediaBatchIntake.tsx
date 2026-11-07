import { useState } from "react";
import type { Product } from "@affiliateos/shared";
import { parseProductMediaBatchManifest } from "@affiliateos/shared";
import { api } from "../api/client";

interface ProductMediaBatchIntakeProps {
  products: Product[];
}

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const imageLimit = 10 * 1024 * 1024;
const videoLimit = 45 * 1024 * 1024;

export function ProductMediaBatchIntake({ products }: ProductMediaBatchIntakeProps) {
  const [manifest, setManifest] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadBatch = async () => {
    if (!manifest || files.length === 0) {
      setError("Pilih satu CSV pemetaan dan seluruh file media yang tercantum di dalamnya.");
      return;
    }
    if (!rightsConfirmed) {
      setError("Konfirmasikan dasar hak penggunaan seluruh file sebelum batch dijalankan.");
      return;
    }

    if (files.length > 200) {
      setError("Maksimal 200 file dapat dipilih dalam satu batch.");
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);
    setProgress("Memeriksa manifest…");
    try {
      const rows = parseProductMediaBatchManifest(await manifest.text());
      const productsByExternalId = new Map<string, Product[]>();
      for (const product of products) {
        const current = productsByExternalId.get(product.externalProductId) ?? [];
        current.push(product);
        productsByExternalId.set(product.externalProductId, current);
      }
      const filesByName = new Map<string, File[]>();
      for (const file of files) {
        const current = filesByName.get(file.name) ?? [];
        current.push(file);
        filesByName.set(file.name, current);
      }

      const resolved = rows.map((row) => {
        const matchingProducts = productsByExternalId.get(row.externalProductId) ?? [];
        if (matchingProducts.length !== 1) {
          throw new Error(`Baris ${row.lineNumber}: ID produk "${row.externalProductId}" tidak ditemukan atau tidak unik dalam katalog.`);
        }
        const matchingFiles = filesByName.get(row.fileName) ?? [];
        if (matchingFiles.length !== 1) {
          throw new Error(`Baris ${row.lineNumber}: file "${row.fileName}" tidak dipilih atau nama file tidak unik.`);
        }
        const file = matchingFiles[0]!;
        const product = matchingProducts[0]!;
        if (product.status !== "active") {
          throw new Error(`Baris ${row.lineNumber}: produk "${row.externalProductId}" tidak aktif.`);
        }
        const isImage = imageTypes.has(file.type);
        const isVideo = file.type === "video/mp4";
        if ((row.kind === "image" && !isImage) || (row.kind === "video" && !isVideo)) {
          throw new Error(`Baris ${row.lineNumber}: jenis media CSV tidak cocok dengan MIME file "${row.fileName}".`);
        }
        const limit = row.kind === "video" ? videoLimit : imageLimit;
        if (file.size <= 0 || file.size > limit) {
          throw new Error(`Baris ${row.lineNumber}: ukuran file "${row.fileName}" harus lebih dari 0 dan maksimal ${Math.round(limit / 1024 / 1024)} MiB.`);
        }
        return { row, product, file };
      });

      const referencedNames = new Set(resolved.map((item) => item.file.name));
      const unusedCount = files.filter((file) => !referencedNames.has(file.name)).length;
      let uploaded = 0;
      const failures: string[] = [];
      for (let index = 0; index < resolved.length; index += 1) {
        const item = resolved[index]!;
        setProgress(`Mengunggah ${index + 1}/${resolved.length}: ${item.file.name} → ${item.product.name}`);
        try {
          const asset = await api.uploadProductMedia(item.product.id, item.file, item.row.kind);
          if (asset.rightsStatus !== "unverified") {
            failures.push(`Baris ${item.row.lineNumber}: status hak yang dikembalikan tidak sesuai kebijakan.`);
          } else {
            uploaded += 1;
          }
        } catch (uploadError) {
          failures.push(`Baris ${item.row.lineNumber} (${item.file.name}): ${uploadError instanceof Error ? uploadError.message : "unggah gagal"}`);
        }
      }

      setResult(
        `Batch selesai: ${uploaded} berhasil, ${failures.length} gagal, ${unusedCount} file tidak dipakai. ` +
        `Semua aset yang berhasil tetap unverified dan wajib diperiksa admin sebelum publikasi.` +
        (failures.length ? ` Rincian: ${failures.join(" | ")}` : "")
      );
      setProgress("");
      setManifest(null);
      setFiles([]);
      setRightsConfirmed(false);
      const manifestInput = document.getElementById("product-media-batch-manifest") as HTMLInputElement | null;
      const filesInput = document.getElementById("product-media-batch-files") as HTMLInputElement | null;
      if (manifestInput) manifestInput.value = "";
      if (filesInput) filesInput.value = "";
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Manifest media tidak dapat diproses.");
      setProgress("");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="shopee-file-summary" aria-labelledby="product-media-batch-title">
      <strong id="product-media-batch-title">Unggah media banyak produk melalui CSV</strong>
      <small>
        Siapkan CSV dengan kolom externalProductId, filename, kind. Nama file harus sama persis dengan nama file yang dipilih.
        Maksimal 200 baris per batch. CSV hanya memetakan file lokal; tidak ada URL Shopee yang diunduh.
      </small>
      <pre>externalProductId,filename,kind{"\n"}SP-100,foto-depan.jpg,image{"\n"}SP-100,video-demo.mp4,video{"\n"}SP-200,produk.png,image</pre>
      <label htmlFor="product-media-batch-manifest">CSV pemetaan media</label>
      <input
        id="product-media-batch-manifest"
        type="file"
        accept=".csv,text/csv"
        disabled={running}
        onChange={(event) => setManifest(event.currentTarget.files?.[0] ?? null)}
      />
      {manifest && <small>Manifest: {manifest.name}</small>}
      <label htmlFor="product-media-batch-files">Pilih file media sesuai manifest</label>
      <input
        id="product-media-batch-files"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,video/mp4"
        disabled={running}
        onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
      />
      <small>{files.length} file dipilih · gambar JPG/PNG/WebP maks. 10 MiB · video MP4 maks. 45 MiB</small>
      <label className="media-rights-confirmation">
        <input
          type="checkbox"
          checked={rightsConfirmed}
          disabled={running}
          onChange={(event) => setRightsConfirmed(event.target.checked)}
        />
        Seluruh file dibuat sendiri atau disertai izin tertulis untuk penggunaan promosi dan penyuntingan. Pernyataan ini bukan bukti audit; admin tetap wajib memeriksa hak setiap aset.
      </label>
      <button type="button" onClick={() => void uploadBatch()} disabled={running || !manifest || files.length === 0 || !rightsConfirmed}>
        {running ? "Memproses batch…" : "Validasi dan unggah batch"}
      </button>
      {progress && <small role="status">{progress}</small>}
      {error && <div className="shopee-import-error" role="alert">{error}</div>}
      {result && <div className="shopee-import-success" role="status">{result}</div>}
    </section>
  );
}
