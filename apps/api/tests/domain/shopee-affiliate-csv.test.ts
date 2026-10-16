import test from "node:test";
import assert from "node:assert/strict";
import { parseShopeeAffiliateCsv } from "../../src/domain/shopee-affiliate-csv.js";

const headers = "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra";

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

test("supports UTF-8 BOM and CRLF line endings", () => {
  const csv = "\uFEFF" + headers + "\r\n" + '2,Produk,107,20,Toko,2%,Rp100,https://shopee.co.id/product/1/2,https://s.shopee.co.id/xyz\r\n';
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.priceRupiah, 107);
});
