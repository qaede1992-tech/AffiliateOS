/**
 * Extracts candidate public media URLs from HTML already obtained from a product page.
 *
 * This module deliberately does not perform network requests. Callers must fetch the
 * product page and each media URL through an SSRF-safe, timeout- and size-bounded
 * transport, then validate bytes before storing anything.
 */
export type ProductMediaKind = "image" | "video";

export interface ProductMediaCandidate {
  kind: ProductMediaKind;
  url: string;
  source: "og" | "twitter" | "json-ld" | "html";
}

export interface ProductMediaExtractionOptions {
  /** Maximum number of unique candidates returned. */
  maxCandidates?: number;
  /** URL of the product page; relative URLs are resolved against this origin. */
  pageUrl: string;
}

const DEFAULT_MAX_CANDIDATES = 20;
const MAX_HTML_CHARS = 2_000_000;
const PRIVATE_IPV4 = /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./i;

const isPublicHttpsUrl = (raw: string, base: URL): string | undefined => {
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return undefined;
    if (PRIVATE_IPV4.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return undefined;
    // Avoid URLs that embed control characters or are likely to be non-media data URLs.
    if (/[\u0000-\u001f\u007f]/.test(url.href)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
};

const decodeCodePoint = (raw: string, radix: number): string => {
  const codePoint = Number.parseInt(raw, radix);
  if (
    !Number.isInteger(codePoint) ||
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
};

const decodeEntities = (value: string): string => value
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#x([\da-f]{1,6});/gi, (_, hex: string) => decodeCodePoint(hex, 16))
  .replace(/&#(\d{1,7});/g, (_, dec: string) => decodeCodePoint(dec, 10));

const attrs = (tag: string): Map<string, string> => {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined && !result.has(name)) result.set(name, decodeEntities(value));
  }
  return result;
};

const collectJsonLd = (value: unknown, add: (kind: ProductMediaKind, raw: string, source: ProductMediaCandidate["source"]) => void): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLd(item, add);
    return;
  }
  const object = value as Record<string, unknown>;
  const type = object["@type"];
  const types = (Array.isArray(type) ? type : [type]).filter((item): item is string => typeof item === "string");
  const isProduct = types.some((item) => /product|individualproduct/i.test(item));
  if (isProduct) {
    const images = object.image;
    for (const item of Array.isArray(images) ? images : images === undefined ? [] : [images]) {
      if (typeof item === "string") add("image", item, "json-ld");
      else if (item && typeof item === "object") {
        const imageObject = item as Record<string, unknown>;
        if (typeof imageObject.url === "string") add("image", imageObject.url, "json-ld");
        if (typeof imageObject.contentUrl === "string") add("image", imageObject.contentUrl, "json-ld");
      }
    }
    const video = object.video;
    for (const item of Array.isArray(video) ? video : video === undefined ? [] : [video]) {
      if (typeof item === "string") add("video", item, "json-ld");
      else if (item && typeof item === "object") {
        const videoObject = item as Record<string, unknown>;
        for (const key of ["contentUrl", "embedUrl", "url"]) {
          if (typeof videoObject[key] === "string") add("video", videoObject[key] as string, "json-ld");
        }
      }
    }
  }
  for (const child of Object.values(object)) {
    if (child && typeof child === "object") collectJsonLd(child, add);
  }
};

/** Extract candidate image/video URLs from public page metadata and product JSON-LD. */
export const extractProductMediaCandidates = (
  html: string,
  options: ProductMediaExtractionOptions
): ProductMediaCandidate[] => {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML_CHARS) return [];
  let base: URL;
  try {
    base = new URL(options.pageUrl);
  } catch {
    return [];
  }
  if (base.protocol !== "https:" || base.username || base.password) return [];
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    throw new Error("maxCandidates must be an integer between 1 and 100.");
  }

  const results: ProductMediaCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: ProductMediaKind, raw: string, source: ProductMediaCandidate["source"]): void => {
    const url = isPublicHttpsUrl(raw, base);
    if (!url) return;
    const key = `${kind}:${url}`;
    if (seen.has(key) || results.length >= maxCandidates) return;
    seen.add(key);
    results.push({ kind, url, source });
  };

  const metaPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0] ?? "";
    const attributes = attrs(tag);
    const property = (attributes.get("property") ?? attributes.get("name") ?? "").toLowerCase();
    const content = attributes.get("content");
    if (!content) continue;
    if (["og:image", "og:image:url", "og:image:secure_url"].includes(property)) add("image", content, "og");
    else if (["twitter:image", "twitter:image:src"].includes(property)) add("image", content, "twitter");
    else if (["og:video", "og:video:url", "og:video:secure_url"].includes(property)) add("video", content, "og");
    else if (["twitter:player:stream"].includes(property)) add("video", content, "twitter");
  }

  const scriptPattern = /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const json = match[1]?.trim();
    if (!json) continue;
    try {
      collectJsonLd(JSON.parse(json) as unknown, add);
    } catch {
      // Malformed or partial JSON-LD must not prevent extraction from other metadata.
    }
  }

  // Last resort: public HTML image/video source attributes; do not fetch these here.
  const mediaTagPattern = /<(?:img|video|source)\b[^>]*>/gi;
  for (const match of html.matchAll(mediaTagPattern)) {
    const attributes = attrs(match[0] ?? "");
    const tag = (match[0] ?? "").slice(1).split(/[\s/>]/, 1)[0]?.toLowerCase();
    const src = attributes.get("src") ?? attributes.get("data-src") ?? attributes.get("data-original");
    if (src && tag === "img") add("image", src, "html");
    if (src && (tag === "video" || tag === "source")) add("video", src, "html");
    const srcset = attributes.get("srcset");
    if (srcset && tag === "img") {
      const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      if (first) add("image", first, "html");
    }
  }

  return results;
};
