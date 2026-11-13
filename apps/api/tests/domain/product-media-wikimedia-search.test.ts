import assert from "node:assert/strict";
import test from "node:test";
import { buildWikimediaCommonsQueries, searchWikimediaCommonsProductMedia } from "../../src/domain/product-media-wikimedia-search.js";

const identity = { name: "Sony WH-1000XM5 Wireless Headphones" };

test("searches Wikimedia Commons and preserves attribution and license evidence", async () => {
  let requestedUrl = "";
  let userAgent = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    userAgent = new Headers(init?.headers).get("user-agent") ?? "";
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Sony WH-1000XM5 Wireless Headphones.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb.jpg",
            url: "https://upload.wikimedia.org/original.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM5.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC BY 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
              Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:Example\">Example Photographer</a>" }
            }
          }]
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const results = await searchWikimediaCommonsProductMedia(identity, { fetchImpl, timeoutMs: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.provider, "wikimedia_commons");
  assert.equal(results[0]?.license, "by");
  assert.equal(results[0]?.licenseVersion, "4.0");
  assert.equal(results[0]?.creator, "Example Photographer");
  assert.equal(results[0]?.creatorUrl, "https://commons.wikimedia.org/wiki/User:Example");
  assert.equal(results[0]?.rightsStatus, "unverified");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.match(requestedUrl, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php/);
  assert.match(requestedUrl, /gsrnamespace=6/);
  assert.ok(userAgent.startsWith("AffiliateOS/"));
});

test("rejects files without an explicitly supported reuse license", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Sony WH-1000XM5 Wireless Headphones.jpg",
        imageinfo: [{
          thumburl: "https://upload.wikimedia.org/thumb.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM5.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC BY-NC 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by-nc/4.0/" }
          }
        }]
      }]
    }
  }), { status: 200 });
  assert.deepEqual(await searchWikimediaCommonsProductMedia(identity, { fetchImpl }), []);
});

test("rejects mismatched model identifiers and non-HTTPS media URLs", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Sony WH-1000XM4 Wireless Headphones.jpg",
        imageinfo: [{
          thumburl: "http://upload.wikimedia.org/thumb.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM4.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC0" },
            LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
          }
        }]
      }]
    }
  }), { status: 200 });
  assert.deepEqual(await searchWikimediaCommonsProductMedia({
    name: "Sony Wireless Headphones",
    model: "WH-1000XM5"
  }, { fetchImpl }), []);
});

test("rejects invalid result limits and reports upstream HTTP failures", async () => {
  await assert.rejects(
    () => searchWikimediaCommonsProductMedia(identity, { maxResults: 21 }),
    /between 1 and 20/
  );
  const fetchImpl: typeof fetch = async () => new Response("blocked", { status: 503 });
  await assert.rejects(
    () => searchWikimediaCommonsProductMedia(identity, { fetchImpl }),
    /HTTP 503/
  );
});


test("rejects non-image files returned from the Commons file namespace", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Sony WH-1000XM5 demonstration.webm",
        imageinfo: [{
          thumburl: "https://thumb.wikimedia.org/video-poster.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM5_demonstration.webm",
          mime: "video/webm",
          extmetadata: {
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0" }
          }
        }]
      }]
    }
  }), { status: 200 });
  assert.deepEqual(await searchWikimediaCommonsProductMedia(identity, { fetchImpl }), []);
});


test("maps Indonesian marketplace listing titles to concise Commons category queries", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "CELAH LANGIT GUMMY BACKPACK | Tas Ransel Lucu Wanita Tas Sekolah Tas Kuliah"
  }), ["backpack"]);
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "MODOFO Tumbler Stainless 710ml Botol Minum Anak Perempuan"
  }), ["water bottle"]);
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Aromanis Brown Sugar 1kg - Gula merah tebu molasses"
  }), ["brown sugar"]);
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "MADU PUTIH MENTAH PREMIUM"
  }), ["honey"]);
});

test("maps lipstick holder marketplace titles to a precise organizer query", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Rak Lipstick / Rak Tempat Lipstick / Rak Meja Lipstick / Rak Lipstick Slot Top006"
  }), ["lipstick holder"]);
});

test("keeps first meaningful product tokens and drops trailing listing codes", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Asthin Force 12 Suplemen Antioksidan Healthy Skin isi 2 Strip"
  }), ["asthin force suplemen"]);
});

test("accepts a properly licensed lipstick organizer as a low-confidence review candidate", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: { pages: [{
      title: "File:Plastic lipstick organizer tray.jpg",
      imageinfo: [{
        thumburl: "https://upload.wikimedia.org/thumb-lipstick-organizer.jpg",
        url: "https://upload.wikimedia.org/lipstick-organizer.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Plastic_lipstick_organizer_tray.jpg",
        mime: "image/jpeg",
        extmetadata: {
          LicenseShortName: { value: "CC0" },
          LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
        }
      }]
    }] }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const results = await searchWikimediaCommonsProductMedia({
    name: "Rak Lipstick / Rak Tempat Lipstick / Rak Meja Lipstick / Rak Lipstick Slot Top006"
  }, { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.rightsStatus, "unverified");
  assert.equal(results[0]?.license, "cc0");
});

test("keeps category-relevant results as low-confidence manual-review candidates", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Military backpack 01.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/backpack.jpg",
            url: "https://upload.wikimedia.org/wikipedia/commons/backpack.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Military_backpack_01.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" }
            }
          }]
        }]
      }
    }), { status: 200 });
  };

  const results = await searchWikimediaCommonsProductMedia({
    name: "Tas Ransel Lucu Wanita Tas Sekolah Tas Kuliah"
  }, { fetchImpl });
  assert.match(requestedUrl, /gsrsearch=backpack/);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.ok((results[0]?.identityScore ?? 100) < 50);
  assert.equal(results[0]?.rightsStatus, "unverified");
  assert.ok(results[0]?.identityReasons.some((reason) => reason.includes("tingkat kategori")));
});

test("hard-rejects category candidates when an explicit model or SKU does not match", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: { pages: [{
      title: "File:Military backpack 01.jpg",
      imageinfo: [{
        thumburl: "https://upload.wikimedia.org/thumb-backpack.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Military_backpack_01.jpg",
        mime: "image/jpeg",
        extmetadata: {
          LicenseShortName: { value: "CC0" },
          LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
        }
      }]
    }] }
  }), { status: 200 });
  const productName = "Tas Ransel Lucu Wanita Tas Sekolah Tas Kuliah";
  for (const identity of [
    { name: productName, model: "RB-900" },
    { name: productName, sku: "RB-900" }
  ]) {
    const results = await searchWikimediaCommonsProductMedia(identity, { fetchImpl });
    assert.deepEqual(results, []);
  }
});


test("filters category search noise using file titles and descriptions", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [
        {
          title: "File:Baby Smurf eating ice cream.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-icecream.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Baby_Smurf_eating_ice_cream.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
              Description: { value: "A fictional baby eating a dessert." }
            }
          }]
        },
        {
          title: "File:Jabiru feeding its babies.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-birds.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Jabiru_feeding_its_babies.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
              Description: { value: "A bird feeding chicks in a nest." }
            }
          }]
        },
        {
          title: "File:GENTLY Baby Calming Baby Cream 50 g product.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-cream.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Barrier_cream_product.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
              Description: { value: "GENTLY Baby Calming Baby Cream 50 g product." }
            }
          }]
        }
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia({
    name: "GENTLY Baby Calming Baby Cream 50 g | Perlengkapan Bayi"
  }, { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "GENTLY Baby Calming Baby Cream 50 g product.jpg");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.rightsStatus, "unverified");
});


test("rejects contextual Wikimedia results that mention a category but do not depict the product", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [
        {
          title: "File:Crispy golden potato wedges on a baking tray ready for serving at home.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-potatoes.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Potato_wedges.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC BY 4.0" },
              LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" }
            }
          }]
        },
        {
          title: "File:GSM Crisper Tray Cooper Carbon Steel Ceramic product.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-crisper.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Crisper_tray.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
            }
          }]
        }
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia({
    name: "GSM Crisper Tray Cooper Carbon Steel Ceramic"
  }, { fetchImpl });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "GSM Crisper Tray Cooper Carbon Steel Ceramic product.jpg");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.rightsStatus, "unverified");
});

test("rejects cat-food donation and wet-food context from dry cat-food product searches", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [
        {
          title: "File:Cat food donation box in Sainsbury's.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-donation.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_food_donation_box.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
            }
          }]
        },
        {
          title: "File:Cat eating wet cat food.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-wet-food.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_eating_wet_cat_food.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
            }
          }]
        },
        {
          title: "File:MR.VET Makanan kucing kering 1kg Dry cat food kibble.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/thumb-kibble.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Dry_cat_food_kibble.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
            }
          }]
        }
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia({
    name: "MR.VET Makanan kucing kering 1kg"
  }, { fetchImpl });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "MR.VET Makanan kucing kering 1kg Dry cat food kibble.jpg");
});

test("rejects a honey-category wildlife image that does not identify the honey product", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: { pages: [{
      title: "File:Oriental honey buzzard Mudumalai Mar21 DSC01405.jpg",
      imageinfo: [{
        thumburl: "https://upload.wikimedia.org/thumb-honey-buzzard.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Oriental_honey_buzzard.jpg",
        mime: "image/jpeg",
        extmetadata: {
          LicenseShortName: { value: "CC0" },
          LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" }
        }
      }]
    }] }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia({
    name: "MADU PUTIH MENTAH PREMIUM 1kg Raw White Honey"
  }, { fetchImpl });

  assert.deepEqual(results, []);
});


test("ignores invalid numeric HTML entities in external attribution metadata", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Sony WH-1000XM5 Wireless Headphones.jpg",
        imageinfo: [{
          thumburl: "https://upload.wikimedia.org/thumb.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM5.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
            Artist: { value: "Example Photographer &#128512; &#0; &#55296; &#65535; &#99999999;" }
          }
        }]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia(identity, { fetchImpl, timeoutMs: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.creator, "Example Photographer 😀");
});
