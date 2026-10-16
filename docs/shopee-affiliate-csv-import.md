# Panduan operasional impor Shopee Affiliate CSV

Status: **panduan sementara — format ekspor resmi belum diverifikasi**.

Panduan ini menjelaskan jalur manual yang disetujui untuk akun Shopee Affiliate yang tidak memiliki akses Open API. Panduan ini tidak mengasumsikan bahwa setiap akun Shopee menampilkan tombol ekspor atau menghasilkan format CSV yang sama.

## 1. Ambil file dari Shopee

1. Masuk ke akun Shopee Affiliate yang memang akan dipakai.
2. Periksa opsi unduh/ekspor yang benar-benar tersedia di akun tersebut. Dokumentasi resmi Shopee tentang [Pedoman Pembuatan Link Pendek Affiliate](https://help.shopee.co.id/portal/10/article/184879-%5BShopee-Affiliate-Program%5D-Pedoman-Pembuatan-Link-Pendek-Affiliate) menyebut jalur **Kreatif > Tampilan Produk > Lihat Link** untuk mengunduh daftar halaman produk dari Product Feed; artikel tersebut menyebut kolom `product_shortlink`.
3. Simpan file asli tanpa mengubah header, urutan kolom, pemisah, atau format angka.
4. Sebelum membagikan contoh untuk debugging, samarkan nama toko/nama produk jika diperlukan dan hapus data pribadi. Pertahankan nama header persis, urutan/jumlah kolom, tanda kutip, format harga/komisi/penjualan, dan bentuk URL agar struktur file tetap bisa diuji.
5. Jangan kirim token API, cookie sesi, kata sandi, atau kredensial Shopee.

**Batas bukti:** artikel resmi yang ditemukan menjelaskan ekspor Product Feed dan kolom `product_shortlink`; artikel itu tidak mendokumentasikan sembilan header yang diwajibkan parser AffiliateOS. Jangan menganggap file Product Feed tersebut langsung kompatibel dengan importer ini. Periksa contoh ekspor aktual dari akun terlebih dahulu dan sesuaikan parser hanya berdasarkan bukti file tersebut.

Jika akun tidak menyediakan ekspor/unduh yang sesuai, hentikan langkah ini dan catat pilihan yang benar-benar tersedia. Jangan mengganti jalur ini dengan scraping, browser automation, endpoint yang ditebak, atau kredensial Open API palsu.

## 2. Format CSV yang dikenali parser

Parser mendukung dua bentuk data:

### A. Format header Shopee berbahasa Indonesia

```csv
ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra
```

Urutan kolom boleh berbeda karena parser memetakan berdasarkan nama header, tetapi semua sembilan header wajib ada dan tidak boleh duplikat. Parser menerima nilai harga/komisi Rupiah dengan pemisah ribuan titik, nilai singkat berakhiran `RB`, persentase komisi sampai 100%, dan jumlah penjualan eksak atau perkiraan berakhiran `RB`.

### B. Format preview bulk-link yang sebelumnya dibagikan

File `shopee_affiliate_import_preview.csv` yang ditemukan di Library percakapan menggunakan header:

```csv
index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url
```

Parser sekarang juga menerima bentuk ini. Kolom `index` boleh ada; field penting lain dipetakan berdasarkan nama header. `price_idr` dan `commission_amount_idr` harus berupa bilangan Rupiah bulat; `commission_rate_bps` harus bilangan bulat 0–10000; `sold_count_quality` harus `exact`, `lower_bound`, atau `missing`. Nilai `lower_bound` dipertahankan sebagai perkiraan batas bawah, bukan diubah menjadi jumlah pasti.

Untuk kedua bentuk, setiap baris harus memiliki jumlah kolom yang sama dengan header, ID produk tidak boleh berulang, nominal komisi tidak boleh melebihi harga, dan URL produk/affiliate harus HTTPS pada host Shopee yang diizinkan.

**Batas bukti:** file yang ditemukan bernama *preview* dan menggunakan skema normalisasi berbahasa Inggris. Dukungan parser terhadap skema tersebut memvalidasi struktur file yang kita miliki, tetapi tidak membuktikan bahwa file itu byte-per-byte merupakan ekspor asli Shopee atau bahwa setiap akun Shopee mengekspor format yang sama. Dokumentasi resmi yang ditemukan menyebut kolom `product_shortlink`, bukan kontrak header di atas. Integrasi ekspor resmi tetap belum terverifikasi sampai dibandingkan dengan file asli dari akun.

## 3. Impor ke AffiliateOS

Endpoint:

`POST /api/v1/marketplaces/shopee-affiliate-feed/import-csv`

Body JSON:

```json
{
  "affiliateId": "<ID affiliate yang sudah ada di AffiliateOS>",
  "csv": "<isi lengkap file CSV sebagai string>",
  "sourceReference": "nama-file.csv"
}
```

- Gunakan bearer token operator melalui konfigurasi lokal yang aman; jangan masukkan token ke dokumentasi, screenshot, atau commit.
- Endpoint dilindungi autentikasi dan otorisasi operator.
- Batas body API adalah 1 MiB.
- CSV divalidasi sebelum persistensi. Jika ada baris tidak valid atau tidak ada baris yang dapat diimpor, endpoint menolak impor dan tidak boleh dianggap sukses sebagian.
- Simpan respons impor untuk rekonsiliasi. Periksa jumlah produk/offer yang diimpor, baris yang diparse, dan daftar error yang dikembalikan.
- Impor ulang file yang sama harus idempoten; periksa bahwa jumlah produk/offer tidak bertambah hanya karena file yang sama diproses ulang.
- Jangan menganggap produk sudah layak dipromosikan hanya karena berhasil diimpor. Tinjau offer, tautan afiliasi, kelayakan, dan alur downstream sesuai kontrol operator.

## 4. Checklist verifikasi sebelum mengaktifkan operasional

- [ ] File berasal dari fitur resmi yang benar-benar tersedia di akun.
- [ ] Header dan jumlah kolom cocok dengan ekspor nyata; tidak sekadar fixture buatan.
- [ ] Harga, persentase/nominal komisi, penjualan, dan URL ditafsirkan dengan benar pada sampel yang representatif.
- [ ] Impor kedua untuk file yang sama tidak menggandakan produk atau offer.
- [ ] Konflik affiliate account ditolak dan tidak mengubah kepemilikan offer yang sudah ada.
- [ ] URL afiliasi yang sudah valid tidak diganti dengan nilai kosong.
- [ ] Ringkasan impor dan alasan penolakan bisa ditinjau operator.
- [ ] Pengujian dilakukan di lingkungan non-production sebelum impor operasional yang lebih besar.

## 5. Batas perubahan

Jalur ini menggunakan impor manual CSV. Jangan menambahkan Shopee Open API tanpa akses resmi yang benar-benar diberikan. Jangan menggunakan scraping, browser automation, atau kredensial palsu. Jangan mengubah alur TikTok, pipeline scoring/campaign/publication, atau database production sebagai bagian dari pekerjaan ini tanpa review dan persetujuan terpisah.
