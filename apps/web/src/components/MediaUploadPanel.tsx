import { useState } from "react";
import type { Content } from "@affiliateos/shared";
import { api } from "../api/client";

type MediaKind = "image" | "thumbnail" | "video";
type Props = { content: Content[] };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const accepts = (kind: MediaKind) => kind === "video" ? "video/mp4,.mp4" : "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
const maxBytes = (kind: MediaKind) => kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

export function MediaUploadPanel({ content }: Props) {
  const [contentId, setContentId] = useState("");
  const [kind, setKind] = useState<MediaKind>("image");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectFile = (candidate?: File) => {
    setError(null);
    setSuccess(null);
    setFile(null);
    if (!candidate) return;
    const allowed = kind === "video" ? candidate.type === "video/mp4" : IMAGE_TYPES.includes(candidate.type);
    if (!allowed) {
      setError(kind === "video" ? "Pilih video MP4." : "Pilih gambar JPEG, PNG, atau WebP.");
      return;
    }
    if (candidate.size <= 0 || candidate.size > maxBytes(kind)) {
      setError(kind === "video" ? "Ukuran video harus lebih dari 0 dan maksimal 45 MiB." : "Ukuran gambar harus lebih dari 0 dan maksimal 10 MiB.");
      return;
    }
    setFile(candidate);
  };

  const upload = async () => {
    if (!contentId || !file) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.uploadMedia(contentId, kind, file);
      setSuccess(`Upload berhasil: ${file.name} · ${(result.byteSize / 1024 / 1024).toFixed(2)} MiB · aset ${result.id.slice(0, 8)}. Bucket tetap privat.`);
      setFile(null);
      const input = document.getElementById("affiliateos-media-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Upload media gagal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="panel" id="media-upload">
      <div className="panel-heading">
        <div><p className="eyebrow">Supabase Storage</p><h3>Unggah media konten</h3></div>
        <span className="badge">Privat</span>
      </div>
      <p>Unggah gambar atau video ke konten yang sudah ada. Endpoint mengirim file sebagai stream dan memvalidasi tipe, signature, serta batas ukuran.</p>
      {content.length === 0 ? <p className="empty">Buat konten berstatus draft terlebih dahulu untuk mengunggah media.</p> : (
        <div className="affiliate-form">
          <label htmlFor="affiliateos-media-content">Konten tujuan</label>
          <select id="affiliateos-media-content" value={contentId} onChange={(event) => { setContentId(event.target.value); setError(null); setSuccess(null); }} disabled={busy}>
            <option value="">Pilih konten</option>
            {content.map((item) => <option key={item.id} value={item.id}>{item.title || item.contentType} · {item.platform} · {item.status}</option>)}
          </select>
          <label htmlFor="affiliateos-media-kind">Jenis media</label>
          <select id="affiliateos-media-kind" value={kind} onChange={(event) => { setKind(event.target.value as MediaKind); setFile(null); setError(null); setSuccess(null); const input = document.getElementById("affiliateos-media-file") as HTMLInputElement | null; if (input) input.value = ""; }} disabled={busy}>
            <option value="image">Gambar konten (maks. 10 MiB)</option>
            <option value="thumbnail">Thumbnail (maks. 10 MiB)</option>
            <option value="video">Video MP4 (maks. 45 MiB)</option>
          </select>
          <label htmlFor="affiliateos-media-file">Pilih file</label>
          <input id="affiliateos-media-file" type="file" accept={accepts(kind)} onChange={(event) => selectFile(event.currentTarget.files?.[0])} disabled={busy || !contentId} />
          {file && <small>{file.name} · {file.size.toLocaleString("id-ID")} byte</small>}
          <button type="button" onClick={() => void upload()} disabled={busy || !contentId || !file}>{busy ? "Mengunggah stream…" : "Unggah ke Storage"}</button>
        </div>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      {success && <p className="shopee-import-success" role="status">{success}</p>}
      <small className="analytics-note">Jenis yang diterima: JPEG, PNG, WebP, atau MP4. Gambar/thumbnail maksimal 10 MiB; video maksimal 45 MiB. Hanya operator/admin yang dapat mengunggah.</small>
    </article>
  );
}
