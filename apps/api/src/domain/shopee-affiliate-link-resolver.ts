import { fetchPublicHttps } from "./public-https-fetch.js";
import type { SafeHttpResponse } from "./public-https-fetch.js";

export interface ShopeeAffiliateLinkResolution {
  status: "resolved" | "unresolved";
  affiliateUrl: string;
  landingUrl?: string;
  productUrl?: string;
  shopId?: string;
  itemId?: string;
  reason?: string;
}
export interface ShopeeAffiliateLinkResolverOptions { maxPageBytes?: number; timeoutMs?: number; maxRedirects?: number; }

const SHOPEE_HOSTS = ["shopee.co.id", "shopee.com"] as const;
const PRODUCT_PATHS = [/\/product\/(\d+)\/(\d+)(?:[/?#]|$)/i, /-i\.(\d+)\.(\d+)(?:[/?#]|$)/i];

function isShopeeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return SHOPEE_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}
function productIdentity(rawUrl: string): { shopId: string; itemId: string } | undefined {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || !isShopeeHost(url.hostname)) return undefined;
  for (const pattern of PRODUCT_PATHS) {
    const match = pattern.exec(url.pathname + url.search);
    if (match?.[1] && match[2]) return { shopId: match[1], itemId: match[2] };
  }
  return undefined;
}
function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function readTagAttribute(tag: string, name: string): string | undefined {
  const expression = "(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))";
  const match = new RegExp(expression, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtml(value.trim()) : undefined;
}
function extractCanonicalUrl(html: string, baseUrl: string): string | undefined {
  const patterns = [/<link\b[^>]*>/gi, /<meta\b[^>]*>/gi];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const tag = match[0] ?? "";
      const rel = readTagAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
      const property = (readTagAttribute(tag, "property") ?? readTagAttribute(tag, "name") ?? "").toLowerCase();
      const isCanonical = rel.includes("canonical") || property === "og:url";
      if (!isCanonical) continue;
      const raw = readTagAttribute(tag, rel.includes("canonical") ? "href" : "content");
      if (!raw) continue;
      try {
        const candidate = new URL(raw, baseUrl);
        if (candidate.protocol === "https:" && isShopeeHost(candidate.hostname)) return candidate.toString();
      } catch { /* Ignore malformed metadata. */ }
    }
  }
  return undefined;
}
function safeFailure(affiliateUrl: string, reason: string): ShopeeAffiliateLinkResolution {
  return { status: "unresolved", affiliateUrl, reason };
}

/** Resolves Shopee affiliate short links without cookies or access-control bypass. */
export async function resolveShopeeAffiliateLink(
  affiliateUrl: string,
  options: ShopeeAffiliateLinkResolverOptions = {},
  fetcher: typeof fetchPublicHttps = fetchPublicHttps
): Promise<ShopeeAffiliateLinkResolution> {
  let input: URL;
  try { input = new URL(affiliateUrl); } catch { return safeFailure(affiliateUrl, "Affiliate link is not a valid URL."); }
  if (input.protocol !== "https:" || input.username || input.password || !isShopeeHost(input.hostname)) {
    return safeFailure(affiliateUrl, "Only credential-free Shopee HTTPS affiliate links are supported.");
  }
  try {
    const page: SafeHttpResponse = await fetcher(input.toString(), {
      maxBytes: options.maxPageBytes ?? 2_000_000,
      timeoutMs: options.timeoutMs ?? 12_000,
      maxRedirects: options.maxRedirects ?? 5,
      allowedHosts: SHOPEE_HOSTS
    });
    const landing = new URL(page.url);
    if (!isShopeeHost(landing.hostname)) return safeFailure(affiliateUrl, "Affiliate link redirected outside the Shopee domain.");
    let productUrl = productIdentity(page.url) ? page.url : undefined;
    if (!productUrl) {
      const canonical = extractCanonicalUrl(new TextDecoder().decode(page.bytes), page.url);
      if (canonical && productIdentity(canonical)) productUrl = canonical;
    }
    if (!productUrl) {
      return { status: "unresolved", affiliateUrl, landingUrl: page.url,
        reason: "Shopee page did not expose a canonical product URL or recognizable product identity. Access restrictions may prevent automatic resolution." };
    }
    const identity = productIdentity(productUrl);
    if (!identity) return safeFailure(affiliateUrl, "Resolved URL does not contain a valid Shopee product identity.");
    return { status: "resolved", affiliateUrl, landingUrl: page.url, productUrl, shopId: identity.shopId, itemId: identity.itemId };
  } catch (error) {
    return safeFailure(affiliateUrl, error instanceof Error ? error.message : "Shopee affiliate link resolution failed.");
  }
}
