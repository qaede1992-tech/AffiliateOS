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
  assert.equal(results[0]?.searchQuery, "sony wireless headphones");
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


test("prioritizes lipstick holder intent over generic cosmetics category", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Rak Lipstick / Rak Tempat Lipstick / Rak Meja Lipstick / Rak Lipstick Slot Top006"
  }), ["lipstick holder"]);
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Hanasui Mattedorable Lipstick"
  }), ["cosmetics and skincare"]);
});

test("keeps the first useful listing tokens and removes trailing product codes", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Pouch Serut Motif Bunga Top006"
  }), ["pouch serut motif"]);
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

test("queues relevant category-only results for mandatory human review instead of discarding them", async () => {
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
  assert.equal(results[0]?.title, "Military backpack 01.jpg");
  assert.equal(results[0]?.searchQuery, "backpack");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.identityScore, 20);
  assert.equal(results[0]?.rightsStatus, "unverified");
  assert.ok(results[0]?.identityReasons.some((reason) => /kategori.*diperiksa manusia/i.test(reason)));
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

test("maps representative Shopee product titles to concise category discovery queries", () => {
  const cases: Array<[string, string]> = [
    ["Unisex Premium Sweater Half Zipper Fleece", "clothing and fashion accessories"],
    ["Aksesoris Mobil Jaring Taruh Hp Rapi Dan Kuat", "automotive accessories"],
    ["Lepet Filter Gantung Aquascape XP06 Free Batu", "aquarium equipment"],
    ["Ternak Syams Goata Base Susu Kambing Etawa Bubuk", "milk powder"],
    ["Flimeal Meal Replacement Coklat Susu", "dietary supplement product"],
    ["Teh Tjap Solo Jumbo Teh Tubruk", "tea and coffee"],
    ["GOGOMART Sikat Sepatu Multifungsi", "shoe cleaning brush"],
    ["Masker Duckbill Isi 50pcs Facemask", "protective face mask"],
    ["Tisu Wajah 3 Ply", "facial tissue"],
    ["JOODUTP Filter Kran Air Kain", "water faucet filter"],
    ["Kahf Antiperspirant Deodorant Roll On", "deodorant"],
    ["RINSO Cair Anti Noda", "household cleaning products"],
    ["Scarlite Perfume Unisex", "perfume bottle"],
    ["Hanasui Mattedorable Lipstick", "cosmetics and skincare"],
    ["INVEN Bulu Mata Tanpa Lem", "false eyelashes"],
    ["Rak Penyimpanan Serbaguna Plastik", "household storage rack"],
    ["Keset Lantai Motif Karakter", "floor mat"],
    ["MamyPoko Pants Diaper", "baby diaper"],
    ["Joyko Permanent Marker Dual Tip", "permanent marker pen"],
    ["Shampo Makarizo Sachet", "shampoo bottle"],
    ["HAN RIVER Kipas Angin 3in1", "electric fan"],
    ["Dapurmanja Panci Masak Stainless Steel", "cookware"],
    ["GOODBABY Keranjang Tirisan Multifungsi 6 In1 Baskom Saringan Sayuran", "colander"],
    ["Tifale Food Kontainer Kotak Penyimpanan Makanan", "food container"],
    ["Omron Wrist Blood Pressure Monitor HEM 6161", "blood pressure monitor"],
    ["Imboost Extra Vit C & D3 Tablet Daya Tahan Tubuh", "dietary supplement product"],
    ["NIIMBOT B1 Printer Label Bluetooth", "label printer"],
    ["Sepatu Sneakers Fashion", "sneakers"]
  ];
  for (const [name, expected] of cases) {
    assert.deepEqual(buildWikimediaCommonsQueries({ name }), [expected], name);
  }
});


test("uses the imported CSV category when a product title does not identify its category", () => {
  assert.deepEqual(buildWikimediaCommonsQueries({
    name: "Item 3pcs Premium",
    category: "Fashion > Bags > Backpack"
  }), ["backpack"]);
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


test("accepts canonical HTTP Creative Commons license metadata and normalizes it to HTTPS", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Milk powder.jpg",
        imageinfo: [{
          thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/milk-powder.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Milk_powder.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC BY-SA 3.0" },
            LicenseUrl: { value: "http://creativecommons.org/licenses/by-sa/3.0/" },
            Artist: { value: "Example Photographer" }
          }
        }]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  const results = await searchWikimediaCommonsProductMedia({
    name: "Zeelandia L'Arome Vanilla Milk Powder 500 Gr"
  }, { fetchImpl, timeoutMs: 1000 });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.license, "by-sa");
  assert.equal(results[0]?.licenseVersion, "3.0");
  assert.equal(results[0]?.licenseUrl, "https://creativecommons.org/licenses/by-sa/3.0/");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.rightsStatus, "unverified");
});

test("rejects license URLs outside the canonical Creative Commons host", async () => {
  const invalidLicenseUrls = [
    "http://creativecommons.org.evil.example/licenses/by/4.0/",
    "https://evil.example/creativecommons.org/licenses/by/4.0/",
    "https://user:password@creativecommons.org/licenses/by/4.0/",
    "ftp://creativecommons.org/licenses/by/4.0/"
  ];
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    query: {
      pages: invalidLicenseUrls.map((licenseUrl, index) => ({
        title: "File:Sony WH-1000XM5 Wireless Headphones " + index + ".jpg",
        imageinfo: [{
          thumburl: "https://upload.wikimedia.org/thumb-" + index + ".jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM5_" + index + ".jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: licenseUrl }
          }
        }]
      }))
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await searchWikimediaCommonsProductMedia(identity, { fetchImpl }), []);
});


test("discovers an Omron blood pressure monitor lead from Commons with rights still unverified", async () => {
  let requestedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:An Omron wrist blood pressure monitor.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/wikipedia/commons/omron-monitor.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:An_Omron_wrist_blood_pressure_monitor.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" },
              Artist: { value: "Example Photographer" }
            }
          }]
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const results = await searchWikimediaCommonsProductMedia({
    name: "Omron Wrist Blood Pressure Monitor HEM 6161"
  }, { fetchImpl });
  assert.match(requestedUrl, /gsrsearch=blood\+pressure\+monitor/);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "An Omron wrist blood pressure monitor.jpg");
  assert.equal(results[0]?.identityStatus, "review_required");
  assert.equal(results[0]?.rightsStatus, "unverified");
});
