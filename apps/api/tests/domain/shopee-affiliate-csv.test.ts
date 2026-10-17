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

test("rejects Shopee URLs containing user credentials or non-standard ports", () => {
  const rows = [
    '12,Produk Kredensial,10RB,100,Toko,5%,Rp500,https://shopee.co.id/product/1/12,https://user:password@s.shopee.co.id/affiliate',
    '13,Produk Port,10RB,100,Toko,5%,Rp500,https://shopee.co.id:8443/product/1/13,https://s.shopee.co.id/affiliate',
  ];
  const result = parseShopeeAffiliateCsv([headers, ...rows].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0]?.message ?? "", /URL HTTPS Shopee/);
  assert.match(result.errors[1]?.message ?? "", /URL HTTPS Shopee/);
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

test("parses the previously shared normalized bulk-link preview CSV", () => {
  const csv = [
    "index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url",
    '0,29302345742,"Duzi Pure, Susu Kuda",107000,10000,lower_bound,"Duzi Official Store",2350,24610,https://shopee.co.id/product/1135631643/29302345742,https://s.shopee.co.id/5AtE274BSv',
    "1,45317937826,Dress Premium Malia,116000,72,exact,NajwaFashionMuslim,1150,12760,https://shopee.co.id/product/67693195/45317937826,https://s.shopee.co.id/1LgVT4ImFv",
  ].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.externalProductId, "29302345742");
  assert.equal(result.rows[0]?.name, "Duzi Pure, Susu Kuda");
  assert.equal(result.rows[0]?.priceRupiah, 107000);
  assert.deepEqual(result.rows[0]?.soldCount, { value: 10000, quality: "lower_bound", sourceText: "10RB+" });
  assert.equal(result.rows[0]?.commissionRateBps, 2350);
  assert.equal(result.rows[0]?.commissionAmountRupiah, 24610);
  assert.equal(result.rows[0]?.affiliateUrl, "https://s.shopee.co.id/5AtE274BSv");
  assert.deepEqual(result.rows[1]?.soldCount, { value: 72, quality: "exact", sourceText: "72" });
  assert.equal(result.rows[1]?.commissionRateBps, 1150);
});

test("preserves non-thousand lower-bound sales values from normalized preview CSV", () => {
  const csv = [
    "index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url",
    "0,29302345742,Produk,107000,1050,lower_bound,Toko,2350,24610,https://shopee.co.id/product/1135631643/29302345742,https://s.shopee.co.id/5AtE274BSv",
  ].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0]?.soldCount, { value: 1050, quality: "lower_bound", sourceText: "1050+" });
});

test("rejects duplicate product IDs in normalized preview CSV", () => {
  const row = "0,29302345742,Produk,107000,10000,lower_bound,Toko,2350,24610,https://shopee.co.id/product/1135631643/29302345742,https://s.shopee.co.id/5AtE274BSv";
  const csv = [
    "index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url",
    row,
    row,
  ].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /external_product_id duplikat/);
});

test("rejects invalid normalized preview commission basis points", () => {
  const csv = [
    "index,external_product_id,name,price_idr,sold_count_value,sold_count_quality,shop_name,commission_rate_bps,commission_amount_idr,product_url,affiliate_url",
    "0,29302345742,Produk,107000,10000,lower_bound,Toko,10001,24610,https://shopee.co.id/product/1135631643/29302345742,https://s.shopee.co.id/5AtE274BSv",
  ].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0]?.message ?? "", /commission_rate_bps harus bilangan bulat/);
});


test("parses the actual LinkProdukSekaligus CSV with RB prices and affiliate links", () => {
  const csv = [
    headers,
    '51510405637,"U-Living Keranjang Laundry Dengan Roda dan Gagang Keranjang Pakaian Kotor Laundry Basket Kapasitas Besar STO052","13,0RB",718,"U-Living Authorized Store Surabaya","6,5%",Rp779,https://shopee.co.id/product/1431148808/51510405637,https://s.shopee.co.id/1BNAo1lYo8',
    '43551822948,"Gojodoq 5000mAh Mini Powerbank Lightning & USB-C","109,0RB","10RB+","Goojodoq In Indonesia","8,5%",Rp8.720,https://shopee.co.id/product/1412347694/43551822948,https://s.shopee.co.id/113kbimC97',
    '52454826619,"TUMS | Permen | Ultra | Asam Lambung | Maag | Gerd | Gas Relief","230,0RB","1RB+",havasu.id,"7,5%",Rp16.100,https://shopee.co.id/product/315495731/52454826619,https://s.shopee.co.id/qkKPPmpU6',
    '55512049095,"Kursi Lipat Lesehan Sofa Lantai Minimalis Floor Chair","55,0RB","4RB+",Aotanna,"7,5%",Rp3.850,https://shopee.co.id/product/1581199983/55512049095,https://s.shopee.co.id/gQuD6nSp5'
  ].join("\n");
  const result = parseShopeeAffiliateCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map((row) => row.externalProductId), [
    "51510405637", "43551822948", "52454826619", "55512049095"
  ]);
  assert.deepEqual(result.rows.map((row) => row.priceRupiah), [13000, 109000, 230000, 55000]);
  assert.deepEqual(result.rows.map((row) => row.commissionRateBps), [650, 850, 750, 750]);
  assert.deepEqual(result.rows.map((row) => row.commissionAmountRupiah), [779, 8720, 16100, 3850]);
  assert.deepEqual(result.rows.map((row) => row.soldCount), [
    { value: 718, quality: "exact", sourceText: "718" },
    { value: 10000, quality: "lower_bound", sourceText: "10RB+" },
    { value: 1000, quality: "lower_bound", sourceText: "1RB+" },
    { value: 4000, quality: "lower_bound", sourceText: "4RB+" }
  ]);
  assert.deepEqual(result.rows.map((row) => row.affiliateUrl), [
    "https://s.shopee.co.id/1BNAo1lYo8",
    "https://s.shopee.co.id/113kbimC97",
    "https://s.shopee.co.id/qkKPPmpU6",
    "https://s.shopee.co.id/gQuD6nSp5"
  ]);
});
