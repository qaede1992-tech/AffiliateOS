import assert from "node:assert/strict";
import test from "node:test";
import { searchWikimediaCommonsProductMedia } from "../../src/domain/product-media-wikimedia-search.js";

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
              Artist: { value: "<a href=\"https://commons.wikimedia.org/wiki/User:Example\">Example Photographer</a>" }
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
