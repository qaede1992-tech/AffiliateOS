import test from "node:test";
import assert from "node:assert/strict";
import { parseShopeeAffiliateCsv } from "../../src/domain/shopee-affiliate-csv.js";

const headers = "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra";

test("rejects duplicate CSV headers instead of silently choosing one", () => {
  const csv = [headers + ",Harga", "1,Produk,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/1,https://s.shopee.co.id/abc,999"].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0]?.message ?? "", /Header CSV duplikat: Harga/);
});
test("rejects CSV rows with missing or extra columns", () => {
  const shortRow = "1,Produk,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/1";
  const longRow = '2,Produk,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/2,https://s.shopee.co.id/abc,unexpected';
  const result = parseShopeeAffiliateCsv([headers, shortRow, longRow].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0]?.message ?? "", /Jumlah kolom tidak sesuai: diharapkan 9, ditemukan 8/);
  assert.match(result.errors[1]?.message ?? "", /Jumlah kolom tidak sesuai: diharapkan 9, ditemukan 10/);
});

test("rejects quotes embedded in an unquoted field", () => {
  const row = '1,Prod"uk,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/1,https://s.shopee.co.id/abc';
  assert.throws(
    () => parseShopeeAffiliateCsv([headers, row].join("\n")),
    /tanda kutip berada di tengah nilai/
  );
});

test("rejects characters after a closing quote before the delimiter", () => {
  const row = '1,"Produk"ekstra,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/1,https://s.shopee.co.id/abc';
  assert.throws(
    () => parseShopeeAffiliateCsv([headers, row].join("\n")),
    /karakter setelah tanda kutip penutup/
  );
});

test("rejects files missing required Shopee headers", () => {
  const result = parseShopeeAffiliateCsv("ID Produk,Nama Produk\n1,Produk");
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0]?.message ?? "", /Kolom wajib tidak ditemukan/);
});

test("parses quoted fields, Indonesian currency and lower-bound sales", () => {
  const csv = [headers, '1,"Minyak, SunCo","37,5RB","10RB+","Toko A","4,5%","Rp1.500","https://shopee.co.id/product/1/1","https://s.shopee.co.id/abc"'].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.name, "Minyak, SunCo");
  assert.equal(result.rows[0]?.priceRupiah, 37500);
  assert.deepEqual(result.rows[0]?.soldCount, { value: 10000, quality: "lower_bound", sourceText: "10RB+" });
  assert.equal(result.rows[0]?.commissionRateBps, 450);
  assert.equal(result.rows[0]?.commissionAmountRupiah, 1500);
  assert.equal(result.rows[0]?.affiliateUrl, "https://s.shopee.co.id/abc");
});

test("rejects duplicate IDs and non-Shopee affiliate URLs", () => {
  const row = '1,Produk,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/1,https://example.com/link';
  const result = parseShopeeAffiliateCsv([headers, row, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0]?.message ?? "", /URL HTTPS Shopee/);
  assert.match(result.errors[1]?.message ?? "", /duplikat/);
});

test("rejects commission amounts greater than product price before import", () => {
  const row = '3,Produk,10RB,100,Toko,5%,Rp12.000,https://shopee.co.id/product/1/3,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Komisi tidak boleh melebihi harga produk/);
});

test("rejects malformed non-empty commission rates instead of silently dropping them", () => {
  const row = '4,Produk,10RB,100,Toko,komisi-lima-persen,Rp500,https://shopee.co.id/product/1/4,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Persentase komisi tidak dapat dibaca/);
});

test("rejects commission rates above 100 percent", () => {
  const row = '5,Produk,10RB,100,Toko,125%,Rp500,https://shopee.co.id/product/1/5,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Persentase komisi tidak dapat dibaca/);
});

test("rejects malformed thousands grouping in Rupiah values", () => {
  const row = '7,Produk,1.2.3,100,Toko,5%,Rp500,https://shopee.co.id/product/1/7,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Harga tidak dapat dibaca/);
});

test("rejects malformed thousands grouping in exact sales counts", () => {
  const row = '8,Produk,10RB,1.2.3,Toko,5%,Rp500,https://shopee.co.id/product/1/8,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Penjualan tidak dapat dibaca/);
});

test("rejects exact sales counts outside JavaScript's safe integer range", () => {
  const row = '9,Produk,10RB,999999999999999999999,Toko,5%,Rp500,https://shopee.co.id/product/1/9,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Penjualan tidak dapat dibaca/);
});

test("rejects abbreviated currency values outside JavaScript's safe integer range", () => {
  const row = '6,Produk,999999999999999RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/6,https://s.shopee.co.id/xyz';
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /Harga tidak dapat dibaca/);
});

test("rejects Rupiah values that become unsafe when converted to integer cents", () => {
  const rows = [
    '10,Produk Harga Terlalu Besar,100000000000000,100,Toko,5%,Rp500,https://shopee.co.id/product/1/10,https://s.shopee.co.id/unsafe10',
    '11,Produk Komisi Terlalu Besar,1000,100,Toko,5%,100000000000000,https://shopee.co.id/product/1/11,https://s.shopee.co.id/unsafe11',
  ];
  const result = parseShopeeAffiliateCsv([headers, ...rows].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0]?.message ?? "", /Harga tidak dapat dibaca/);
  assert.match(result.errors[1]?.message ?? "", /Komisi tidak dapat dibaca/);
});

test("supports UTF-8 BOM and CRLF line endings", () => {
  const csv = "\uFEFF" + headers + "\r\n" + '2,Produk,107,20,Toko,2%,Rp100,https://shopee.co.id/product/1/2,https://s.shopee.co.id/xyz\r\n';
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.priceRupiah, 107);
});
