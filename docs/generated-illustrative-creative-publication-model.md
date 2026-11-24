# Model Publikasi Materi Ilustratif Buatan AffiliateOS

Status: rancangan teknis, belum mengubah perilaku aplikasi.

## Tujuan

Menyediakan jalur yang sah untuk memublikasikan video promosi ilustratif yang dibuat AffiliateOS dari teks dan grafis sendiri, tanpa mengambil foto/video Shopee, tanpa mengklaim hak atas media pihak ketiga, dan tanpa melemahkan pemeriksaan hak media produk yang sudah ada.

Video ilustratif bukan foto atau representasi visual aktual produk. Renderer saat ini menampilkan nama dan harga produk serta disclaimer "ILUSTRASI PROMOSI - BUKAN FOTO PRODUK".

## Temuan implementasi saat ini

1. `product_media_assets.rights_basis` hanya menerima `explicit_permission`, `license`, `public_domain`, `user_owned`, dan `platform_authorization`.
2. `hasCurrentVerifiedRights()` mewajibkan status verified, basis hak, URL bukti HTTPS, waktu verifikasi, dan penerbit sumber.
3. Jalur publikasi Instagram memanggil `assertProductMediaRightsForPublication()` sebelum dispatch. Media object-storage pada namespace `content/<contentId>/...` ditolak untuk konten yang terhubung ke produk karena belum memiliki provenance hak produk.
4. Menambahkan nilai `generated` ke `rights_basis` bukan solusi yang tepat: itu mencampuradukkan hak atas media pihak ketiga dengan provenance materi yang dibuat sendiri.
5. PR #966 hanya menghasilkan MP4 sementara. PR #967 hanya menyediakan preview admin, menandai rights `unverified`, dan tidak membuat konten atau memublikasikan.
6. Gerbang baru tersebut saat ini dibatasi pada Instagram Graph. Jalur TikTok sengaja tidak diubah.

## Model yang direkomendasikan

Pisahkan **provenance materi ilustratif** dari **hak media produk eksternal**.

Tambahkan entitas khusus, misalnya `generated_product_creatives`, yang terhubung ke:
- satu `media_assets.id` (file yang dipakai konten),
- satu `product_id`,
- opsional `affiliate_offer_id` yang menjadi dasar promosi,
- versi renderer dan template,
- hash SHA-256 output,
- snapshot fakta yang benar-benar dirender (nama produk, harga dalam minor units, mata uang, waktu snapshot),
- status pemeriksaan kreatif (`pending`, `approved`, `rejected`),
- status disclaimer dan format (9:16, durasi, codec),
- waktu pembuatan dan identitas pembuat sistem.

Entitas ini **tidak** mengisi atau mengubah `product_media_assets.rights_status`, `rights_basis`, atau audit hak media. Ia membuktikan asal-usul kreatif AffiliateOS, bukan hak atas foto/video produk.

### Kebijakan aktivasi

Gunakan persetujuan kebijakan satu kali oleh admin AffiliateOS untuk mengaktifkan kelas materi ilustratif pada platform tertentu. Jangan mewajibkan persetujuan manual pihak marketplace, seller, atau pihak ketiga. Catat aktor, waktu, versi kebijakan, platform yang diizinkan, serta batasan yang disetujui.

Setelah kebijakan diaktifkan, tiap output tetap harus lolos validasi deterministik. Jika kebijakan belum aktif, materi hanya boleh menjadi preview.

### Pemeriksaan sebelum publikasi

Publikasi hanya dapat lolos bila seluruh syarat berikut terpenuhi:

1. Konten terhubung ke produk yang aktif dan masih lolos seleksi non-media terbaru.
2. Offer dan affiliate link yang dipakai masih aktif, tersedia, dan belum kedaluwarsa.
3. Fakta yang dirender cocok dengan snapshot produk terkini; jika nama/harga berubah, materi harus dibuat ulang.
4. Media yang dilampirkan cocok secara unik dengan baris creative provenance, product, content, MIME type, ukuran, dan hash saat dibuat.
5. Renderer/template termasuk versi yang diizinkan kebijakan.
6. Disclaimer wajib tertanam pada video; tidak ada foto, logo, merek, klaim spesifikasi, ulasan, atau visual produk yang tidak bersumber.
7. Status creative approved dan kebijakan platform masih aktif.
8. Caption/CTA hanya menggunakan fakta dan affiliate link aktif yang divalidasi ulang tepat sebelum dispatch.
9. Gerbang dievaluasi ulang saat dispatch dan saat rekonsiliasi publikasi, bukan hanya ketika konten dibuat.

Jika salah satu syarat gagal, publikasi ditolak secara fail-closed. Status kreatif tidak boleh dipakai untuk meloloskan media eksternal yang tidak memiliki rights evidence.

## Biaya dan egress — penghalang sebelum integrasi publikasi

Renderer dan preview sekarang tidak menulis ke Supabase. Integrasi publikasi tidak boleh menambahkan upload berulang, download ulang, atau pemindaian katalog.

Instagram Graph membutuhkan URL media yang dapat diambil provider. Jika URL tersebut berasal dari Supabase Storage, pengambilan oleh provider dapat menambah egress. Karena penggunaan egress Supabase AffiliateOS sebelumnya sudah berlebihan, jalur publikasi tidak boleh diaktifkan sebelum:
- lokasi penyimpanan dan jalur delivery dipilih,
- estimasi ukuran file dan jumlah publikasi dihitung,
- kebijakan retensi dan deduplikasi ditetapkan,
- dampak egress diukur pada staging dengan satu aset uji,
- mekanisme pencegahan regenerasi dan upload duplikat dibuktikan.

Jangan melakukan read-back file dari Storage hanya untuk menghitung hash; hash dihitung saat render dan dipertahankan bersama provenance. Jangan mengaktifkan autonomous cycle untuk materi ini sampai semua batas biaya terukur.

## Tahapan implementasi yang aman

1. Pertahankan PR #966 dan #967 sebagai preview-only sampai rancangan ini diimplementasikan dan diuji.
2. Tambahkan schema/repository/audit provenance kreatif yang terpisah dari tabel hak media eksternal.
3. Tambahkan pemeriksaan publikasi khusus untuk media ilustratif pada jalur Instagram saja, dengan tes dispatch dan rekonsiliasi.
4. Tambahkan kebijakan aktivasi admin satu kali dan uji bahwa kebijakan nonaktif selalu memblokir.
5. Buktikan integritas file dan biaya delivery di staging menggunakan satu produk yang lolos seleksi.
6. Baru setelah itu pertimbangkan integrasi content creation dan publication. Jangan mengubah TikTok dalam rangkaian pekerjaan ini.

## Kriteria penerimaan

- Materi ilustratif tidak pernah ditandai sebagai `user_owned`, `public_domain`, atau hak media produk terverifikasi.
- Foto/video Shopee dan media pihak ketiga tetap memerlukan pemeriksaan hak yang sudah ada.
- Konten produk dengan media tak dikenal, provenance hilang, offer tidak aktif, atau fakta kedaluwarsa tetap diblokir.
- Kebijakan yang belum diaktifkan tidak dapat memublikasikan materi ilustratif.
- TikTok tetap tidak berubah.
- Tidak ada siklus idle, katalog scan, unduhan eksternal, atau penulisan Storage tambahan yang berjalan otomatis.
- Tidak ada perubahan atau migrasi yang diterapkan ke staging/production sebagai bagian dari dokumen rancangan ini.
