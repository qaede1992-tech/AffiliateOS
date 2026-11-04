import {
  evaluateProductMediaIdentity,
  type ProductMediaCatalogCandidate,
  type ProductMediaSearchIdentity
} from "./product-media-catalog-search.js";

export interface WikimediaCommonsSearchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResults?: number;
  userAgent?: string;
}

interface WikimediaMetadataValue {
  value?: unknown;
}

interface WikimediaImageInfo {
  url?: unknown;
  thumburl?: unknown;
  descriptionurl?: unknown;
  mime?: unknown;
  extmetadata?: Record<string, WikimediaMetadataValue>;
}

interface WikimediaPage {
  title?: unknown;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaSearchResponse {
  query?: { pages?: WikimediaPage[] };
}

const safeHttps = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const metadataText = (metadata: Record<string, WikimediaMetadataValue> | undefined, key: string): string | null => {
  const value = metadata?.[key]?.value;
  if (typeof value !== "string") return null;
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000) || null;
};

const normalizedLicense = (licenseUrl: string | null, licenseName: string | null): {
  license: string;
  licenseUrl: string | null;
} | null => {
  const url = (licenseUrl ?? "").toLowerCase();
  if (/creativecommons\.org\/(publicdomain\/zero|licenses\/zero)\//.test(url) || /^cc0$/i.test(licenseName ?? "")) {
    return { license: "cc0", licenseUrl };
  }
  if (/creativecommons\.org\/publicdomain\/mark\//.test(url) || /^public domain$/i.test(licenseName ?? "")) {
    return { license: "pdm", licenseUrl };
  }
  if (/creativecommons\.org\/licenses\/by-sa\//.test(url)) return { license: "by-sa", licenseUrl };
  if (/creativecommons\.org\/licenses\/by\//.test(url)) return { license: "by", licenseUrl };
  return null;
};

/**
 * Search Wikimedia Commons for image candidates. Commons metadata is treated
 * as discovery evidence only: all candidates remain rights-unverified and
 * pending human review before any download, ingestion, or publication.
 */
export async function searchWikimediaCommonsProductMedia(
  identity: ProductMediaSearchIdentity,
  options: WikimediaCommonsSearchOptions = {}
): Promise<ProductMediaCatalogCandidate[]> {
  const query = [identity.brand, identity.name, identity.model, identity.sku, identity.variant]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .slice(0, 200);
  if (!query.trim()) return [];

  const maxResults = options.maxResults ?? 10;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new Error("maxResults must be an integer between 1 and 20.");
  }

  const endpoint = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(maxResults),
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "800",
    iiextmetadatalanguage: "en"
  })) endpoint.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": options.userAgent ?? "AffiliateOS/1.0 (https://affiliateos.affiliateos.blitz.cloud; contact: qaede1992@gmail.com) Node.js"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Wikimedia Commons search failed with HTTP ${response.status}.`);
    const payload = await response.json() as WikimediaSearchResponse;
    const pages = Array.isArray(payload.query?.pages) ? payload.query.pages : [];

    return pages.flatMap((page) => {
      const title = typeof page.title === "string" ? page.title.replace(/^File:/i, "").trim().slice(0, 1000) : "";
      const info = page.imageinfo?.[0];
      if (!title || !info) return [];
      const imageUrl = safeHttps(info.thumburl) ?? safeHttps(info.url);
      const landingPageUrl = safeHttps(info.descriptionurl);
      if (!imageUrl || !landingPageUrl) return [];

      const metadata = info.extmetadata;
      const licenseName = metadataText(metadata, "LicenseShortName");
      const licenseUrl = safeHttps(metadata?.LicenseUrl?.value);
      const acceptedLicense = normalizedLicense(licenseUrl, licenseName);
      if (!acceptedLicense) return [];

      const identityMatch = evaluateProductMediaIdentity(identity, title);
      if (identityMatch.status === "rejected") return [];

      return [{
        provider: "wikimedia_commons" as const,
        title,
        imageUrl,
        landingPageUrl,
        creator: metadataText(metadata, "Artist"),
        creatorUrl: safeHttps(metadata?.Artist?.value && typeof metadata.Artist.value === "string"
          ? metadata.Artist.value.match(/href=["']([^"']+)["']/i)?.[1]
          : null),
        license: acceptedLicense.license,
        licenseVersion: licenseName?.match(/\d+(?:\.\d+)?/)?.[0] ?? null,
        licenseUrl: acceptedLicense.licenseUrl,
        sourcePublisher: "Wikimedia Commons",
        identityScore: identityMatch.score,
        identityStatus: identityMatch.status,
        identityReasons: [...identityMatch.reasons, "Kandidat ditemukan melalui Wikimedia Commons API."],
        rightsStatus: "unverified" as const
      }];
    }).sort((left, right) => right.identityScore - left.identityScore);
  } finally {
    clearTimeout(timeout);
  }
}
