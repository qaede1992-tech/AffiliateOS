# Panduan operasional impor Shopee Affiliate CSV

Status: **panduan sementara — format ekspor resmi belum diverifikasi secara umum**.

Panduan ini mendokumentasikan impor manual CSV untuk akun Shopee Affiliate biasa. Jangan mengasumsikan akun tersebut memiliki Open API, App ID/App Secret, menu Kreatif, atau akses Product Feed. Alur harus memakai file yang memang dapat diperoleh pengguna dari akun yang digunakan.

## 1. Siapkan file CSV yang benar-benar tersedia

1. Masuk ke akun Shopee Affiliate yang memang akan dipakai.
2. Gunakan hanya pilihan daftar/unduh/ekspor yang benar-benar tersedia pada akun tersebut. Jangan mengarahkan pengguna ke menu Kreatif atau Product Feed jika menu itu tidak tersedia untuk akunnya.
3. Fixture yang diuji untuk pekerjaan ini berasal dari file `LinkProdukSekaligus` yang dibagikan pemilik proyek. Pertahankan file asli tanpa mengubah header, urutan kolom, pemisah, tanda kutip, atau format angka.
4. Sebelum membagikan contoh untuk debugging, samarkan data pribadi jika diperlukan. Pertahankan nama header persis, jumlah kolom, tanda kutip, format harga/komisi/penjualan, dan bentuk URL agar struktur file tetap bisa diuji.
5. Jangan kirim token API, cookie sesi, kata sandi, atau kredensial Shopee.

**Batas bukti:** pengujian membuktikan parser dapat membaca struktur file `LinkProdukSekaligus` yang tersedia dalam pekerjaan ini. Itu tidak membuktikan bahwa semua akun Affiliate biasa menyediakan file yang sama atau bahwa format tersebut merupakan kontrak ekspor resmi Shopee untuk semua akun. Jika akun tidak menyediakan file yang cocok, catat pilihan yang benar-benar tersedia dan jangan menebak format.

Jangan mengganti alur ini dengan scraping, browser automation, endpoint privat yang ditebak, atau kredensial Open API palsu.

## 2. Format CSV yang dikenali parser

Parser mendukung dua bentuk data:

### A. Format header Indonesia dari file `LinkProdukSekaligus`

```csv
ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra
```

Urutan kolom boleh berbeda karena parser memetakan berdasarkan nama header, tetapi semua sembilan header wajib ada dan tidak boleh duplikat. Parser menerima nilai harga/komisi Rupiah dengan pemisah ribuan titik, nilai singkat berakhiran `RB`, persentase komisi sampai 100%, dan jumlah penjualan eksak atau perkiraan berakhiran `RB`.

### B. Format preview bulk-link yang sebelumnya dibagikan

File `shopee_affiliate_import_preview.csv` yang ditemukan di Library percakapan menggunakan header:

```csv
index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url
```

Parser juga menerima bentuk ini. Kolom `index` boleh ada; field penting lain dipetakan berdasarkan nama header. `price_idr` dan `commission_amount_idr` harus berupa bilangan Rupiah bulat; `commission_rate_bps` harus bilangan bulat 0–10000; `sold_count_quality` harus `exact`, `lower_bound`, atau `missing`. Nilai `lower_bound` dipertahankan sebagai perkiraan batas bawah, bukan diubah menjadi jumlah pasti.

Untuk kedua bentuk, setiap baris harus memiliki jumlah kolom yang sama dengan header, ID produk tidak boleh berulang, nominal komisi tidak boleh melebihi harga, dan URL produk/affiliate harus HTTPS pada host Shopee yang diizinkan.

**Batas bukti:** format preview berbahasa Inggris adalah skema normalisasi yang pernah dibagikan, bukan bukti bahwa Shopee menyediakannya langsung kepada akun Affiliate biasa. Dukungan parser untuk format preview hanya membuktikan struktur file tersebut dapat diproses. Jangan menganggap kedua format tersedia pada semua akun.

## 3. Impor ke AffiliateOS

### Melalui dashboard

1. Buka dashboard operator AffiliateOS di jalur `/app` dan masuk menggunakan autentikasi operator.
2. Buka bagian **Impor CSV Shopee**.
3. Pilih record affiliate yang memang terikat pada akun Shopee sumber file.
4. Pilih file `.csv` yang asli. Antarmuka menerima file hingga 450 KiB untuk menjaga ukuran body JSON tetap di bawah batas API.
5. Periksa nama dan ukuran file, lalu tekan **Validasi & impor CSV** dan konfirmasi.
6. Jika validasi gagal, baca daftar baris dan alasan kesalahan; perbaiki sumber CSV, jangan mengedit angka atau URL secara spekulatif. Tidak ada data batch yang boleh tersimpan pada penolakan validasi.
7. Jika impor berhasil, tinjau jumlah produk/offer yang diproses dan periksa daftar offer marketplace pada dashboard.

### Melalui API

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

- [ ] File berasal dari alur yang benar-benar tersedia di akun yang digunakan.
- [ ] Header dan jumlah kolom cocok dengan file asli; bukan hanya fixture buatan.
- [ ] Harga, persentase/nominal komisi, penjualan, dan URL ditafsirkan dengan benar pada sampel yang representatif.
- [ ] Impor kedua untuk file yang sama tidak menggandakan produk atau offer.
- [ ] Konflik affiliate account ditolak dan tidak mengubah kepemilikan offer yang sudah ada.
- [ ] URL afiliasi yang sudah valid tidak diganti dengan nilai kosong.
- [ ] Ringkasan impor dan alasan penolakan bisa ditinjau operator.
- [ ] Pengujian dilakukan di lingkungan non-production sebelum impor operasional yang lebih besar.

## 5. Batas perubahan

Jalur ini menggunakan impor manual CSV dan tidak mensyaratkan Open API, App ID/App Secret, menu Kreatif, atau Product Feed. Jangan menggunakan scraping, browser automation, atau kredensial palsu. Jangan mengubah alur TikTok, pipeline scoring/campaign/publication, atau database production sebagai bagian dari pekerjaan ini tanpa review dan persetujuan terpisah.
