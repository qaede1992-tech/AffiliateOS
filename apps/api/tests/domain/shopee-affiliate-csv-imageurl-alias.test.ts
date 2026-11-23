import test from "node:test";
import assert from "node:assert/strict";
import { parseShopeeAffiliateCsv } from "../../src/domain/shopee-affiliate-csv.js";

const previewHeaders = "index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url,imageUrl";
const previewRow = "0,12345,Produk,10000,100,exact,Toko,500,500,https://shopee.co.id/product/1/12345,https://s.shopee.co.id/abc,https://cdn.example.com/product.jpg";

test("accepts camelCase imageUrl in normalized preview CSV", () => {
  const result = parseShopeeAffiliateCsv([previewHeaders, previewRow].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0]?.imageUrl, "https://cdn.example.com/product.jpg");
});

test("accepts camelCase imageUrl in standard Shopee CSV", () => {
  const headers = "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra,imageUrl";
  const row = "12345,Produk,10.000,100,Toko,5%,Rp500,https://shopee.co.id/product/1/12345,https://s.shopee.co.id/abc,https://cdn.example.com/product.jpg";
  const result = parseShopeeAffiliateCsv([headers, row].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0]?.imageUrl, "https://cdn.example.com/product.jpg");
});
