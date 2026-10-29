import test from "node:test";
import assert from "node:assert/strict";
import { extractProductMediaCandidates } from "../src/domain/product-media-discovery.js";

const pageUrl = "https://shopee.co.id/product/123/456";

test("extracts Open Graph image and video metadata independent of attribute order", () => {
  const html = `
    <html><head>
      <meta content="https://down-id.img.susercontent.com/file/main.jpg" property="og:image">
      <meta property='og:video' content='https://video.example-cdn.com/item.mp4'>
      <meta name="twitter:image" content="https://cdn.example.com/second.webp">
    </head></html>`;
  const result = extractProductMediaCandidates(html, { pageUrl });
  assert.deepEqual(result.map(({ kind, url, source }) => ({ kind, url, source })), [
    { kind: "image", url: "https://down-id.img.susercontent.com/file/main.jpg", source: "og" },
    { kind: "video", url: "https://video.example-cdn.com/item.mp4", source: "og" },
    { kind: "image", url: "https://cdn.example.com/second.webp", source: "twitter" }
  ]);
});

test("extracts product images and videos from JSON-LD", () => {
  const html = `<script type="application/ld+json">
    {"@type":"Product","image":["https://cdn.example.com/a.jpg",{"url":"https://cdn.example.com/b.jpg"}],
     "video":{"contentUrl":"https://cdn.example.com/a.mp4"}}
  </script>`;
  const result = extractProductMediaCandidates(html, { pageUrl });
  assert.deepEqual(result.map(({ kind, url }) => ({ kind, url })), [
    { kind: "image", url: "https://cdn.example.com/a.jpg" },
    { kind: "image", url: "https://cdn.example.com/b.jpg" },
    { kind: "video", url: "https://cdn.example.com/a.mp4" }
  ]);
});

test("resolves relative public media URLs and deduplicates candidates", () => {
  const html = `
    <meta property="og:image" content="//cdn.example.com/a.jpg">
    <meta property="og:image:url" content="https://cdn.example.com/a.jpg">
    <img src="/images/primary.jpg">
  `;
  const result = extractProductMediaCandidates(html, { pageUrl });
  assert.deepEqual(result.map(({ url }) => url), [
    "https://cdn.example.com/a.jpg",
    "https://shopee.co.id/images/primary.jpg"
  ]);
});

test("rejects non-HTTPS, credentialed, and private-network candidates", () => {
  const html = `
    <meta property="og:image" content="http://cdn.example.com/a.jpg">
    <meta property="og:image" content="https://user:pass@cdn.example.com/b.jpg">
    <meta property="og:image" content="https://127.0.0.1/private.jpg">
    <meta property="og:image" content="https://192.168.1.10/private.jpg">
    <meta property="og:image" content="https://host.local/private.jpg">
    <meta property="og:image" content="data:image/png;base64,AAAA">
    <meta property="og:image" content="https://cdn.example.com/good.jpg">
  `;
  assert.deepEqual(extractProductMediaCandidates(html, { pageUrl }).map(({ url }) => url), [
    "https://cdn.example.com/good.jpg"
  ]);
});

test("ignores malformed JSON-LD and invalid page URLs without throwing", () => {
  assert.deepEqual(extractProductMediaCandidates("<script type='application/ld+json'>{bad</script>", { pageUrl }), []);
  assert.deepEqual(extractProductMediaCandidates("<meta property='og:image' content='https://cdn.example.com/a.jpg'>", { pageUrl: "javascript:alert(1)" }), []);
});

test("does not throw on invalid numeric HTML entities in metadata attributes", () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/invalid&#x110000;.jpg">
    <meta property="og:image" content="https://cdn.example.com/valid.jpg">
  `;
  const result = extractProductMediaCandidates(html, { pageUrl });
  assert.ok(result.some(({ url }) => url === "https://cdn.example.com/valid.jpg"));
});

test("caps candidate count and rejects unreasonable limits", () => {
  const html = Array.from({ length: 5 }, (_, i) => `<meta property="og:image" content="https://cdn.example.com/${i}.jpg">`).join("");
  assert.equal(extractProductMediaCandidates(html, { pageUrl, maxCandidates: 2 }).length, 2);
  assert.throws(() => extractProductMediaCandidates(html, { pageUrl, maxCandidates: 101 }), /maxCandidates/);
});

test("ignores oversized HTML input", () => {
  assert.deepEqual(extractProductMediaCandidates("x".repeat(2_000_001), { pageUrl }), []);
});
