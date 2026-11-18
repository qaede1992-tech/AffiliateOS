import assert from "node:assert/strict";
import test from "node:test";
import { parseShopeeAffiliateCsv } from "../src/domain/shopee-affiliate-csv.js";

const headers = ["ID Produk", "Nama Produk", "Harga", "Penjualan", "Nama Toko", "Komisi hingga", "Komisi", "Link Produk", "Link Komisi Ekstra"];
const row = ["123", "Produk Contoh", "100000", "1.000", "Toko Contoh", "5%", "5000", "https://shopee.co.id/product/1", "https://shope.ee/abc"];

test("Shopee CSV accepts optional product identity metadata without changing required columns", () => {
  const csv = [...headers, "Merek", "Model", "SKU", "Varian"].join(",") + "\n" + [...row, "MerekX", "Model-1", "SKU-9", "Hitam 1L"].join(",");
  const result = parseShopeeAffiliateCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(
    { brand: result.rows[0]?.brand, model: result.rows[0]?.model, sku: result.rows[0]?.sku, variant: result.rows[0]?.variant },
    { brand: "MerekX", model: "Model-1", sku: "SKU-9", variant: "Hitam 1L" }
  );
});

test("Shopee CSV remains backward compatible without identity columns", () => {
  const result = parseShopeeAffiliateCsv(headers.join(",") + "\n" + row.join(","));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.brand, undefined);
});

test("Shopee CSV rejects ambiguous identity aliases and overlong identity values", () => {
  const ambiguous = [...headers, "Merek", "Brand"].join(",") + "\n" + [...row, "A", "B"].join(",");
  assert.match(parseShopeeAffiliateCsv(ambiguous).errors[0]?.message ?? "", /satu kolom/);
  const tooLong = [...headers, "SKU"].join(",") + "\n" + [...row, "X".repeat(121)].join(",");
  assert.match(parseShopeeAffiliateCsv(tooLong).errors[0]?.message ?? "", /120 karakter/);
});
