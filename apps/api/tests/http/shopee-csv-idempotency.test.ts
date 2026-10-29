import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("Shopee CSV import is idempotent when the same export is submitted twice", async () => {
  const app = createApp();
  try {
    const affiliateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/affiliates",
      payload: { name: "Idempotent CSV Partner", email: "idempotent-csv@example.com" },
    });
    assert.equal(affiliateResponse.statusCode, 201);
    const affiliate = affiliateResponse.json();

    const csv = [
      "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
      '51510405637,"Keranjang Laundry","Rp13.000","718","U-Living","6,5%","Rp779","https://shopee.co.id/product/1431148808/51510405637","https://s.shopee.co.id/1BNAo1lYo8"',
      '43551822948,"Mini Powerbank","Rp109.000","10RB+","Gojodoq","8,5%","Rp8.720","https://shopee.co.id/product/1412347694/43551822948","https://s.shopee.co.id/113kbimC97"',
    ].join("\n");

    const importCsv = () => app.inject({
      method: "POST",
      url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
      payload: { affiliateId: affiliate.id, csv, sourceReference: "repeat-export.csv" },
    });

    const first = await importCsv();
    assert.equal(first.statusCode, 201);
    const firstResult = first.json();
    assert.equal(firstResult.importedProducts, 2);
    assert.equal(firstResult.importedOffers, 2);

    const second = await importCsv();
    assert.equal(second.statusCode, 201);
    const secondResult = second.json();
    assert.equal(secondResult.importedProducts, 2);
    assert.equal(secondResult.importedOffers, 2);
    assert.deepEqual(secondResult.affiliateOfferIds, firstResult.affiliateOfferIds);

    const products = await app.inject({ method: "GET", url: "/api/v1/products" });
    const offers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
    assert.equal(products.statusCode, 200);
    assert.equal(offers.statusCode, 200);
    assert.equal(products.json().data.length, 2);
    assert.equal(offers.json().data.length, 2);
  } finally {
    await app.close();
  }
});


test("Shopee CSV reimport without an image column preserves previously imported product media", async () => {
  const app = createApp();
  try {
    const affiliateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/affiliates",
      payload: { name: "Media Preservation Partner", email: "media-preservation@example.com" },
    });
    assert.equal(affiliateResponse.statusCode, 201);
    const affiliate = affiliateResponse.json();

    const productUrl = "https://shopee.co.id/product/123/456";
    const affiliateUrl = "https://s.shopee.co.id/abc";
    const imageUrl = "https://cf.shopee.co.id/file/product-image.jpg";
    const csvWithImage = [
      "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra,Link Gambar",
      `456,"Produk Media","Rp55.000","100","Toko Media","8,5%","Rp4.675","${productUrl}","${affiliateUrl}","${imageUrl}"`,
    ].join("\n");
    const csvWithoutImage = [
      "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
      `456,"Produk Media","Rp55.000","100","Toko Media","8,5%","Rp4.675","${productUrl}","${affiliateUrl}"`,
    ].join("\n");

    const importCsv = (csv: string) => app.inject({
      method: "POST",
      url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
      payload: { affiliateId: affiliate.id, csv },
    });
    const first = await importCsv(csvWithImage);
    assert.equal(first.statusCode, 201);
    const afterFirst = await app.inject({ method: "GET", url: "/api/v1/products" });
    assert.equal(afterFirst.json().data[0].imageUrl, imageUrl);
    const productId = afterFirst.json().data[0].id;
    const videoUrl = "https://cf.shopee.co.id/file/product-video.mp4";
    const addVideo = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media`,
      payload: { videoUrl },
    });
    assert.equal(addVideo.statusCode, 200);

    const second = await importCsv(csvWithoutImage);
    assert.equal(second.statusCode, 201);
    const afterSecond = await app.inject({ method: "GET", url: "/api/v1/products" });
    assert.equal(afterSecond.json().data.length, 1);
    assert.equal(afterSecond.json().data[0].imageUrl, imageUrl);
    assert.equal(afterSecond.json().data[0].videoUrl, videoUrl);
  } finally {
    await app.close();
  }
});

test("Shopee CSV import keeps affiliate accounts separate for the same marketplace feed", async () => {
  const app = createApp();
  try {
    const createAffiliate = async (name: string, email: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/affiliates",
        payload: { name, email },
      });
      assert.equal(response.statusCode, 201);
      return response.json();
    };
    const oldAffiliate = await createAffiliate("Legacy Partner", "legacy-partner@example.com");
    const newAffiliate = await createAffiliate("New Fashion IDN", "newfashion-test@example.com");
    const csv = [
      "ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra",
      '"51510405637","Keranjang Laundry","Rp13.000","718","U-Living","6,5%","Rp779","https://shopee.co.id/product/1431148808/51510405637","https://s.shopee.co.id/1BNAo1lYo8"',
    ].join("\n");

    const importFor = (affiliateId: string) => app.inject({
      method: "POST",
      url: "/api/v1/marketplaces/shopee-affiliate-feed/import-csv",
      payload: { affiliateId, csv, sourceReference: "multi-affiliate-export.csv" },
    });

    const first = await importFor(oldAffiliate.id);
    assert.equal(first.statusCode, 201);
    const firstOfferId = first.json().affiliateOfferIds[0];

    const second = await importFor(newAffiliate.id);
    assert.equal(second.statusCode, 201);
    const secondOfferId = second.json().affiliateOfferIds[0];
    assert.notEqual(secondOfferId, firstOfferId);

    const verification = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers/verification" });
    assert.equal(verification.statusCode, 200);
    const oldOffer = verification.json().data.find((offer: { id: string }) => offer.id === firstOfferId);
    const newOffer = verification.json().data.find((offer: { id: string }) => offer.id === secondOfferId);
    assert.equal(oldOffer.affiliateId, oldAffiliate.id);
    assert.equal(newOffer.affiliateId, newAffiliate.id);

    const products = await app.inject({ method: "GET", url: "/api/v1/products" });
    const offers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers" });
    assert.equal(products.json().data.length, 1);
    assert.equal(offers.json().data.length, 2);
  } finally {
    await app.close();
  }
});
