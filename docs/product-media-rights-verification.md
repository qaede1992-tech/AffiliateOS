# Verifikasi Hak Media Produk

## Status dokumen

Dokumen ini memisahkan **perilaku yang benar-benar berjalan di `main`** dari **kebijakan target yang belum diterapkan**. Pemeriksaan kode terakhir dilakukan pada 15 November 2026 terhadap commit `1bc8e61295782c3b5f6a2206378152dff892c7f7`.

Dokumen ini hanya spesifikasi dan koreksi dokumentasi. Perubahan ini tidak mengubah runtime, skema, database, Storage, kredensial, deployment, atau pengaturan publikasi.

## Ringkasan perilaku saat ini

Implementasi saat ini belum menjamin bahwa seluruh sumber media mempunyai provenance hak yang dapat diaudit. Jangan menyebut semua media yang dapat dipublikasikan sebagai media yang sudah diverifikasi haknya.

### Pemeriksaan pada jalur dispatch baru

`PublisherExecutor.execute()` memanggil `resolveMediaAssets(content, true)` sebelum membaca kredensial sosial. Pemeriksaan `assertProductMediaRightsForPublication` berlaku pada:

- Objek Storage dengan namespace `products/<productId>/...`. Product ID harus tertaut ke konten dan harus cocok dengan tepat satu baris `product_media_assets` berdasarkan product ID, bucket, dan object key.
- URL eksternal yang sama persis dengan `sourceUrl` dari aset produk tertaut. Jika ada kecocokan, harus ada tepat satu record dan provenance haknya harus masih valid.

Provenance dianggap valid hanya jika status `verified`, basis hak termasuk enum yang didukung, URL bukti menggunakan HTTPS tanpa username/password, identitas publisher tidak kosong, dan waktu verifikasi valid serta tidak berada di masa depan.

Aset product-scoped yang tidak tertaut, referensi Storage yang malformed, record yang hilang/ambigu, atau hak yang belum diverifikasi/dicabut akan memblokir dispatch.

### Jalur legacy yang belum dilindungi

Kode saat ini secara eksplisit mempertahankan kompatibilitas berikut:

- Upload object-storage dengan namespace `content/<contentId>/...` tidak diperiksa oleh gate product-media.
- Namespace object-storage legacy selain `products/<productId>/...` juga dilewati oleh gate tersebut.
- URL eksternal yang tidak cocok dengan `sourceUrl` aset produk tertaut tidak diblokir oleh gate product-media.

Jalur-jalur tersebut masih dapat diteruskan oleh resolver publisher lama. Record `media_assets` tidak dengan sendirinya membuktikan siapa pemilik media atau bahwa AffiliateOS mempunyai izin komersial untuk memublikasikannya. Karena itu, media legacy dan URL eksternal yang tidak memiliki provenance **belum dapat dianggap rights-verified**.

### Jalur rekonsiliasi Instagram yang tertunda

Pada `main` saat pemeriksaan ini, `PublisherExecutor.check()` memanggil `resolveMediaAssets(content)` tanpa mengaktifkan pemeriksaan product-media rights. Instagram dapat membuat container terlebih dahulu, lalu memanggil `media_publish` setelah status container menjadi `FINISHED`. Dengan demikian, pemeriksaan pada `execute()` bukan pemeriksaan terakhir sebelum permintaan final tersebut.

PR #842 menambahkan pemeriksaan hak pada status `FINISHED` tepat sebelum `media_publish`. PR itu masih Draft dan belum menghilangkan race karena `PublicationOperation` belum menyimpan snapshot immutable dari ID media persis yang digunakan saat container dibuat. Konten/media dapat berubah pada rentang antara pembuatan container dan penyimpanan operation.

Jangan merge atau menyatakan celah ini selesai hanya berdasarkan CI PR #842. Snapshot yang persis, immutable, dan terikat pada operation harus dirancang serta diuji terlebih dahulu.

## Kebijakan target

Kebijakan berikut adalah persyaratan untuk implementasi berikutnya, bukan klaim tentang perilaku runtime saat ini:

1. Setiap aset hasil ingest, upload, atau generasi dimulai sebagai `unverified`.
2. Tidak ada URL, keberhasilan download, tampilan pada halaman produk, atau hasil generasi yang dengan sendirinya membuktikan hak publikasi.
3. Semua jalur media—product-scoped, content-scoped, URL eksternal, dan namespace legacy—harus mempunyai provenance yang sesuai atau diblokir sebelum provider menerima media.
4. Pemeriksaan harus memakai aset yang persis sama dengan yang akan dikirim ke provider, bukan sekadar daftar media terbaru milik konten.
5. Operation untuk publikasi bertahap harus menyimpan snapshot immutable dari ID aset, referensi object-storage yang relevan, serta identitas/checksum yang diperlukan untuk memastikan media yang diperiksa sama dengan media pada container.
6. Dispatch baru, retry, scheduled job, dan recovery harus membaca status hak terkini. Untuk Instagram, pemeriksaan final harus terjadi setelah container `FINISHED` dan tepat sebelum `media_publish`, menggunakan snapshot operation yang sama.
7. Jika lookup gagal, provenance hilang/ambigu, hak dicabut, atau snapshot tidak cocok, blokir dispatch. Jangan fallback diam-diam ke URL cache atau record legacy.
8. Hak media sumber tidak otomatis diwariskan ke video turunan. Musik, footage, merek, dan materi lain yang disertakan dapat membutuhkan penilaian tersendiri.
9. Permintaan yang sudah diterima platform eksternal tidak selalu dapat dibatalkan oleh aplikasi. Status in-flight dan batas pembatalan tersebut harus dapat diaudit.

## Workflow review hak yang dituju

### Otorisasi dan identitas reviewer

Hanya role `admin` yang boleh memverifikasi atau mencabut hak. Model autentikasi saat ini menggunakan satu konfigurasi `operatorId` dan satu role (`admin | operator | viewer`); ini bukan sistem identitas multi-user atau RBAC per pengguna.

Endpoint review harus menolak pengguna tanpa autentikasi (401) dan role selain admin (403). Actor ID, role, dan timestamp berasal dari konteks server, bukan body permintaan.

### Bukti dan basis hak

Basis yang didukung oleh enum skema:

- `explicit_permission`: izin tertulis dari pemegang hak atau wakil yang berwenang.
- `license`: lisensi yang mencakup penggunaan komersial dan distribusi yang dimaksud.
- `public_domain`: dasar domain publik yang dapat dipertanggungjawabkan untuk karya dan yurisdiksi terkait.
- `user_owned`: pernyataan kepemilikan dan kewenangan atas penggunaan yang dimaksud.
- `platform_authorization`: otorisasi platform yang secara eksplisit mencakup penggunaan ulang tersebut.

Reviewer harus memeriksa bukti aktual dan memastikan cakupannya meliputi aset, publisher/sumber, tujuan komersial, format, wilayah, platform, serta masa berlaku yang relevan. URL bukti adalah referensi untuk pemeriksaan manusia, bukan bukti otomatis.

Jangan mengambil URL bukti arbitrer dari server untuk mencoba membuktikan hak. Selain tidak membuktikan izin hukum, pengambilan URL arbitrer dapat membuka risiko SSRF. Bukti diperiksa oleh reviewer melalui jalur yang berada di luar batas kepercayaan jaringan server.

### Transisi status

Transisi yang diizinkan:

- `unverified -> verified`: admin menyertakan basis hak yang didukung, referensi bukti HTTPS, identitas publisher/sumber, dan alasan review yang bermakna.
- `unverified -> revoked`: admin mencatat alasan larangan/pencabutan.
- `verified -> revoked`: admin mencatat alasan; aset tidak lagi memenuhi syarat publikasi.
- `revoked -> verified`: hanya setelah review baru atas bukti terkini dan menghasilkan audit baru.

Setiap tindakan harus menambahkan event audit append-only yang mencatat asset ID, actor ID/role, tindakan, status sebelumnya/berikutnya, basis, referensi bukti, alasan, dan waktu. Jangan menyimpan token, secret, atau isi dokumen bukti di log biasa. Perubahan status aset dan penambahan audit harus atomik dalam satu transaksi; jika salah satu gagal, seluruh transaksi dibatalkan.

## Kontrak API yang dituju

- `GET /api/v1/product-media-assets?rightsStatus=unverified`: antrean review berpaginasi tanpa secret Storage atau signed URL.
- `POST /api/v1/product-media-assets/:assetId/rights/verify`: menerima `rightsBasis`, `rightsEvidenceUrl`, `sourcePublisher`, dan alasan reviewer yang tidak kosong.
- `POST /api/v1/product-media-assets/:assetId/rights/revoke`: menerima alasan pencabutan yang tidak kosong.

Server menolak basis tidak didukung, URL non-HTTPS atau URL dengan kredensial tertanam, publisher kosong, alasan kosong, aset tidak dikenal, serta body yang mencoba mengatur `rightsVerifiedAt`, `actorId`, `actorRole`, atau `rightsStatus`.

Implementasi memerlukan workflow/repository khusus yang mengunci baris aset, memvalidasi transisi, memperbarui provenance, dan menulis audit dalam satu transaksi Drizzle. Audit tidak menyediakan jalur update/delete bagi role aplikasi. Tabel dan privilege mengikuti pola private-table yang sudah ada; tidak memberikan akses ke `public`, `anon`, atau `authenticated`.

## Persyaratan snapshot publikasi

Sebelum final dispatch Instagram diperbaiki, operation perlu menyimpan snapshot immutable dari media yang benar-benar digunakan untuk membuat container. Snapshot harus ditulis pada urutan yang aman dan tidak boleh dibuat dari daftar media terbaru setelah container sudah dibuat.

Perlu ada pengujian untuk:
- media berubah atau dihapus setelah container dibuat;
- hak dicabut saat container masih diproses;
- media snapshot tidak cocok dengan media yang akan dikirim;
- container `FINISHED` versus `PUBLISHED` yang hanya memerlukan rekonsiliasi;
- retry dan recovery tanpa membuat duplikasi publikasi;
- kegagalan lookup atau audit yang harus fail closed.

PR #842 saat ini hanya merupakan lapisan recheck sementara dan tetap Draft sampai persoalan snapshot tersebut diselesaikan. Tidak ada perubahan TikTok yang menjadi bagian dari PR dokumentasi ini.

## Pengujian wajib

- unauthenticated mendapat 401; operator/viewer mendapat 403; admin dapat mengakses antrean dan mengirim keputusan yang valid;
- body tidak dapat memalsukan actor, role, timestamp, atau status;
- field bukti yang hilang/tidak valid dan alasan kosong ditolak;
- verifikasi menulis tepat satu audit event dan timestamp/actor berasal dari server;
- pencabutan langsung mengeluarkan aset dari jalur yang memenuhi syarat publikasi;
- verifikasi ulang setelah pencabutan menambah event baru tanpa menghapus histori;
- operasi verify/revoke bersamaan tidak membuat status dan audit tidak konsisten;
- audit tidak memiliki jalur update/delete pada role aplikasi;
- seluruh tipe sumber media mengikuti kebijakan provenance target;
- retry, scheduled job, dan recovery membaca hak terkini;
- snapshot Instagram tetap identik dari container creation sampai final dispatch;
- tidak ada provider upload/post ketika pemeriksaan gagal.

## Batas rollout

Dokumen ini tidak menerapkan workflow, migration, RLS, ACL, Storage, kredensial, atau perubahan runtime. Implementasi harus melalui PR terpisah dengan tes dan review. Jangan menerapkan migration ke Production atau Staging, mengubah permission, menyalakan autonomous publication, atau memublikasikan konten sebagai bagian dari pekerjaan dokumentasi ini.

## Temuan implementasi yang telah diverifikasi (15 November 2026)

- `PublisherExecutor.execute()` memeriksa media sebelum membaca kredensial sosial.
- Gate saat ini hanya melindungi product-scoped object-storage dan URL yang cocok dengan sumber aset produk tertaut; jalur content-scoped/legacy dan URL eksternal yang tidak cocok tetap kompatibel.
- `PublisherExecutor.check()` tidak memanggil gate hak product-media pada `main`.
- `PublicationOperation` saat ini menyimpan content ID, job ID, provider, provider operation ID, status, dan timestamp; belum menyimpan media snapshot.
- PR #842 menambahkan recheck Instagram untuk container `FINISHED`, tetapi tidak menghilangkan race snapshot. PR tetap Draft.
- PR #853 adalah dokumentasi saja. Tidak ada perubahan runtime atau database yang dilakukan oleh PR ini.
