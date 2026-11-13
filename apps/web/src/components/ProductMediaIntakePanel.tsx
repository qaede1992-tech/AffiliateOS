import { useEffect, useMemo, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api } from "../api/client";

export function ProductMediaIntakePanel() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProducts = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.products();
      setProducts(response.data);
      setSelectedId((current) => current && response.data.some((product) => product.id === current)
        ? current
        : response.data.find((product) => !product.imageUrl || !product.videoUrl)?.id ?? response.data[0]?.id ?? "");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Daftar produk tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadProducts(); }, []);

  const selectedProduct = products.find((product) => product.id === selectedId);
  const missingMediaCount = products.filter((product) => !product.imageUrl && !product.videoUrl).length;
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("id-ID");
    return [...products]
      .sort((a, b) => Number(!b.imageUrl && !b.videoUrl) - Number(!a.imageUrl && !a.videoUrl) || a.name.localeCompare(b.name, "id"))
      .filter((product) => !query || product.name.toLocaleLowerCase("id-ID").includes(query) || product.externalProductId.toLocaleLowerCase("id-ID").includes(query));
  }, [products, search]);

  useEffect(() => {
    setImageUrl(selectedProduct?.imageUrl ?? "");
    setVideoUrl(selectedProduct?.videoUrl ?? "");
    setRightsConfirmed(false);
    setImageFile(null);
    setVideoFile(null);
    setNotice(null);
  }, [selectedId]);

  const uploadSelectedFiles = async () => {
    if (!selectedProduct || (!imageFile && !videoFile)) {
      setError("Pilih file gambar atau video yang akan diunggah.");
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const uploaded: string[] = [];
      if (imageFile) {
        await api.uploadProductMedia(selectedProduct.id, "image", imageFile);
        uploaded.push("gambar");
      }
      if (videoFile) {
        await api.uploadProductMedia(selectedProduct.id, "video", videoFile);
        uploaded.push("video");
      }
      setImageFile(null);
      setVideoFile(null);
      setNotice(`File ${uploaded.join(" dan ")} berhasil diunggah. Status hak tetap UNVERIFIED dan wajib ditinjau admin pada panel Verifikasi Hak Media sebelum dapat dipakai untuk publikasi.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "File media gagal diunggah.");
    } finally {
      setUploading(false);
    }
  };

  const saveMedia = async () => {
    if (!selectedProduct) return;
    const image = imageUrl.trim();
    const video = videoUrl.trim();
    if (!image && !video) {
      setError("Masukkan setidaknya satu URL gambar atau video langsung.");
      return;
    }
    for (const [label, value] of [["Gambar", image], ["Video", video]] as const) {
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      } catch {
        setError(`URL ${label.toLowerCase()} harus berupa tautan HTTPS langsung tanpa kredensial.`);
        return;
      }
    }
    if (!rightsConfirmed) {
      setError("Konfirmasikan terlebih dahulu bahwa Anda berhak menggunakan seluruh media yang dimasukkan.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateProductMedia(selectedProduct.id, {
        ...(image ? { imageUrl: image } : {}),
        ...(video ? { videoUrl: video } : {})
      });
      setProducts((current) => current.map((product) => product.id === updated.id ? updated : product));
      setImageUrl(updated.imageUrl ?? "");
      setVideoUrl(updated.videoUrl ?? "");
      setRightsConfirmed(false);
      setNotice("URL media tersimpan. Media akan divalidasi dan di-ingest ketika produk lolos seleksi awal autonomous.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "URL media gagal disimpan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="panel shopee-import-panel" id="product-media-intake">
      <div className="panel-heading">
        <div><p className="eyebrow">Kelengkapan katalog</p><h3>Media Produk</h3></div>
        <span className="badge">{missingMediaCount} tanpa media</span>
      </div>
      <p>Tambahkan URL HTTPS langsung ke gambar atau video produk dari sumber yang mengizinkan penggunaan promosi. Masukkan URL file media, bukan URL halaman produk Shopee atau tautan affiliate.</p>
      {loading ? <p className="empty">Memuat katalog produk…</p> : products.length === 0 ? <p className="empty">Belum ada produk. Impor penawaran affiliate terlebih dahulu.</p> : (
        <div className="affiliate-form">
          <label htmlFor="product-media-search">Cari produk</label>
          <input id="product-media-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nama atau ID produk" />
          <label htmlFor="product-media-product">Pilih produk</label>
          <select id="product-media-product" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {filteredProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.imageUrl || product.videoUrl ? "media tersedia" : "tanpa media"}</option>)}
          </select>
          {selectedProduct && <>
            <div className="shopee-file-summary">
              <strong>{selectedProduct.name}</strong>
              <small>ID produk: {selectedProduct.externalProductId} · <a href={selectedProduct.productUrl} target="_blank" rel="noreferrer">Buka halaman produk</a></small>
            </div>
            <div className="shopee-file-summary">
              <strong>Unggah file media langsung</strong>
              <small>Gambar: JPEG, PNG, WebP (maks. 10 MiB). Video: MP4 (maks. 45 MiB).</small>
            </div>
            <label htmlFor="product-media-image-file">File gambar produk</label>
            <input id="product-media-image-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 10 * 1024 * 1024) { setImageFile(null); setError("Ukuran gambar melebihi batas 10 MiB."); event.currentTarget.value = ""; return; } setImageFile(file); setError(null); }} />
            <label htmlFor="product-media-video-file">File video produk</label>
            <input id="product-media-video-file" type="file" accept="video/mp4,.mp4" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 45 * 1024 * 1024) { setVideoFile(null); setError("Ukuran video melebihi batas 45 MiB."); event.currentTarget.value = ""; return; } setVideoFile(file); setError(null); }} />
            <button type="button" onClick={() => void uploadSelectedFiles()} disabled={uploading || (!imageFile && !videoFile)}>{uploading ? "Mengunggah file…" : "Unggah file media"}</button>
            <p className="shopee-import-note">Upload menyimpan aset dengan status hak UNVERIFIED. Upload tidak membuktikan kepemilikan atau lisensi dan tidak membuat aset otomatis siap publikasi. Admin harus memeriksa bukti hak pada panel Verifikasi Hak Media.</p>
            <label htmlFor="product-media-image">URL gambar langsung (opsional)</label>
            <input id="product-media-image" type="url" inputMode="url" placeholder="https://cdn.example.com/product-image.jpg" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} />
            <label htmlFor="product-media-video">URL video langsung (opsional)</label>
            <input id="product-media-video" type="url" inputMode="url" placeholder="https://cdn.example.com/product-video.mp4" value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} />
            <label className="media-rights-confirmation">
              <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
              Saya memiliki izin/hak untuk menggunakan media ini dalam konten promosi affiliate.
            </label>
            <button type="button" onClick={() => void saveMedia()} disabled={saving || !rightsConfirmed}>{saving ? "Menyimpan…" : "Simpan URL media"}</button>
          </>}
        </div>
      )}
      {error && <div className="shopee-import-error" role="alert"><strong>Media belum tersimpan</strong><p>{error}</p></div>}
      {notice && <div className="shopee-import-success" role="status"><strong>Berhasil</strong><p>{notice}</p></div>}
      <p className="shopee-import-note">AffiliateOS tidak mengambil gambar/video dari HTML halaman Shopee. URL yang dimasukkan akan diperiksa saat proses media discovery; konten hanya dibuat setelah produk lolos seleksi akhir dan media siap digunakan.</p>
      <button type="button" className="secondary-button" onClick={() => void loadProducts()} disabled={loading || saving}>Muat ulang katalog</button>
    </article>
  );
}
