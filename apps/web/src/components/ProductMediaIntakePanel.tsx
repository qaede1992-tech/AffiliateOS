import { useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@affiliateos/shared";
import { api } from "../api/client";

export function ProductMediaIntakePanel() {
  const panelRef = useRef<HTMLElement | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
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
        : response.data.find((product) => !product.imageUrl && !product.videoUrl)?.id ?? response.data[0]?.id ?? "");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Daftar produk tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (typeof IntersectionObserver === "undefined") {
      void loadProducts();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void loadProducts();
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

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
    setUploadFile(null);
    setNotice(null);
  }, [selectedId]);

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
        const host = parsed.hostname.toLowerCase();
        if (/(^|\.)shopee\./.test(host) || host === "susercontent.com" || host.endsWith(".susercontent.com") || host === "shopeeusercontent.com" || host.endsWith(".shopeeusercontent.com")) {
          setError(`URL ${label.toLowerCase()} berasal dari domain Shopee/CDN. AffiliateOS tidak mengunduh materi Shopee secara otomatis; unggah file yang dibuat sendiri atau diberikan penjual dengan izin penggunaan.`);
          return;
        }
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
      setNotice("URL media tersimpan. Konfirmasi hak penggunaan belum tercatat sebagai audit dan media belum dianggap terverifikasi untuk publikasi.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "URL media gagal disimpan.");
    } finally {
      setSaving(false);
    }
  };

  const uploadMedia = async () => {
    if (!selectedProduct || !uploadFile) return;
    const kind = uploadFile.type.startsWith("image/") ? "image" : uploadFile.type === "video/mp4" ? "video" : null;
    const allowedImage = ["image/jpeg", "image/png", "image/webp"].includes(uploadFile.type);
    if (!kind || (kind === "image" && !allowedImage)) { setError("Format file harus JPG, PNG, WebP, atau MP4."); return; }
    const limit = kind === "video" ? 45 * 1024 * 1024 : 10 * 1024 * 1024;
    if (uploadFile.size <= 0 || uploadFile.size > limit) { setError(`Ukuran ${kind === "video" ? "video" : "gambar"} harus lebih dari 0 dan maksimal ${Math.round(limit / 1024 / 1024)} MiB.`); return; }
    if (!rightsConfirmed) { setError("Konfirmasikan hak penggunaan media sebelum mengunggah."); return; }
    setUploading(true); setError(null); setNotice(null);
    try {
      const asset = await api.uploadProductMedia(selectedProduct.id, uploadFile, kind);
      setNotice(`${kind === "video" ? "Video" : "Gambar"} tersimpan di penyimpanan privat AffiliateOS (SHA-256 ${asset.sha256.slice(0, 12)}…). Status hak tetap ${asset.rightsStatus}; admin harus memeriksa bukti izin sebelum aset dapat digunakan untuk publikasi.`);
      setUploadFile(null);
      const input = document.getElementById("product-media-file") as HTMLInputElement | null;
      if (input) input.value = "";
      setRightsConfirmed(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "File media gagal diunggah.");
    } finally { setUploading(false); }
  };

  return (
    <article ref={panelRef} className="panel shopee-import-panel" id="product-media-intake">
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
            <label htmlFor="product-media-image">URL gambar langsung (opsional)</label>
            <input id="product-media-image" type="url" inputMode="url" placeholder="https://cdn.example.com/product-image.jpg" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} />
            <label htmlFor="product-media-video">URL video langsung (opsional)</label>
            <input id="product-media-video" type="url" inputMode="url" placeholder="https://cdn.example.com/product-video.mp4" value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} />
            <label className="media-rights-confirmation">
              <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
              Media dibuat sendiri atau saya memiliki izin tertulis dari pemegang hak untuk menggunakannya dalam promosi, termasuk penyuntingan/produksi konten. Bukti tetap harus diperiksa admin sebelum publikasi.
            </label>
            <button type="button" onClick={() => void saveMedia()} disabled={saving || !rightsConfirmed}>{saving ? "Menyimpan…" : "Simpan URL media eksternal"}</button>
            <div className="shopee-file-summary"><strong>Unggah file media yang berizin</strong><small>Gunakan foto/video buatan sendiri atau file yang dikirim penjual disertai izin tertulis untuk penggunaan promosi dan penyuntingan. Jangan mengunduh otomatis dari halaman atau CDN Shopee.</small></div>
            <label htmlFor="product-media-file">File gambar/video</label>
            <input id="product-media-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" onChange={(event) => setUploadFile(event.currentTarget.files?.[0] ?? null)} disabled={uploading} />
            <small>Format yang diterima: JPG/PNG/WebP maksimal 10 MiB atau MP4 maksimal 45 MiB.</small>
            {uploadFile && <small>{uploadFile.name} · {uploadFile.size.toLocaleString("id-ID")} byte</small>}
            <button type="button" onClick={() => void uploadMedia()} disabled={uploading || !uploadFile || !rightsConfirmed}>{uploading ? "Mengunggah media…" : "Unggah gambar/video"}</button>
          </>}
        </div>
      )}
      {error && <div className="shopee-import-error" role="alert"><strong>Media belum tersimpan</strong><p>{error}</p></div>}
      {notice && <div className="shopee-import-success" role="status"><strong>URL tersimpan</strong><p>{notice}</p></div>}
      <p className="shopee-import-note">Hak media tidak otomatis dianggap sah hanya karena file dapat diunggah. Untuk foto/video dari penjual, simpan bukti izin tertulis yang mencakup kanal promosi dan hak penyuntingan/produksi konten, lalu masukkan saat Review media produk. Aset baru berstatus verified setelah admin memeriksa bukti. Materi kreatif Shopee yang hanya berlisensi untuk ditampilkan tanpa perubahan tidak boleh diolah menjadi karya turunan tanpa izin tertulis terpisah.</p>
      <button type="button" className="secondary-button" onClick={() => void loadProducts()} disabled={loading || saving}>Muat ulang katalog</button>
    </article>
  );
}
