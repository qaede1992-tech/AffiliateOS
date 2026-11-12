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

interface WikimediaMetadataValue { value?: unknown; }
interface WikimediaImageInfo {
  url?: unknown;
  thumburl?: unknown;
  descriptionurl?: unknown;
  mime?: unknown;
  extmetadata?: Record<string, WikimediaMetadataValue>;
}
interface WikimediaPage { title?: unknown; imageinfo?: WikimediaImageInfo[]; }
interface WikimediaSearchResponse { query?: { pages?: WikimediaPage[] }; }

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
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const codePoint = Number(code);
      const isXmlCharacter = codePoint === 0x9
        || codePoint === 0xA
        || codePoint === 0xD
        || (codePoint >= 0x20 && codePoint <= 0xD7FF)
        || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
        || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
      return isXmlCharacter ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000) || null;
};

const categoryQueries: Array<{ pattern: RegExp; query: string; relevant: RegExp; exclude?: RegExp }> = [
  { pattern: /\b(backpack|rucksack|ransel|tas sekolah|tas kuliah)\b/i, query: "backpack", relevant: /\b(backpack|rucksack|knapsack|school bag)\b/i },
  { pattern: /\b(botol minum|tumbler|termos|water bottle)\b/i, query: "water bottle", relevant: /\b(water bottle|bottle|thermos|flask|canteen)\b/i },
  { pattern: /\b(charger|pengisi daya|fast charging)\b/i, query: "charger", relevant: /\b(charger|charging adapter|power adapter)\b/i },
  { pattern: /\b(brown sugar|gula merah|gula aren|gula tebu)\b/i, query: "brown sugar", relevant: /\b(brown sugar|palm sugar|jaggery)\b/i, exclude: /\b(making of|production of|factory|harvest|field)\b/i },
  { pattern: /\b(cat food|makanan kucing|pakan kucing)\b/i, query: "cat food", relevant: /\b(cat food|kibble|cat kibble|dry cat food)\b/i, exclude: /\b(donation|donation box|donation booth|shelter|charity|feeding program|wet (?:cat )?food)\b/i },
  { pattern: /\b(baby cream|krim bayi|baby lotion|perlengkapan bayi)\b/i, query: "baby cream", relevant: /\b(baby cream|barrier cream|skin cream|lotion|moisturizer|ointment|skincare)\b/i },
  { pattern: /\b(hand soap|hand wash|sabun cuci tangan)\b/i, query: "hand soap", relevant: /\b(hand soap|hand wash|liquid soap|soap dispenser|handwashing)\b/i },
  { pattern: /\b(honey|madu)\b/i, query: "honey", relevant: /\b(honey|honeycomb|honey jar|bee honey)\b/i, exclude: /\b(buzzard|bird|raptor|eagle|hawk|falcon|owl|vulture|wildlife)\b/i },
  { pattern: /\b(hair clip|hair clips|jepit rambut|perhiasan rambut)\b/i, query: "hair clips", relevant: /\b(hair clip|hair clips|hair clasp|barrette|hairpin)\b/i },
  { pattern: /\b(crisper tray|air fryer|baking tray)\b/i, query: "crisper tray", relevant: /\b(crisper tray|air fryer|oven tray)\b/i, exclude: /\b(potato wedges|food served|ready for serving|serving tray)\b/i }
];

/**
 * Commons is a general media library, not a product catalog. Search using a
 * normalized category phrase rather than the full marketplace listing title.
 */
export const buildWikimediaCommonsQueries = (identity: ProductMediaSearchIdentity): string[] => {
  const source = [identity.brand, identity.name, identity.model, identity.sku, identity.variant]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  if (!source.trim()) return [];

  const matchedCategory = categoryQueries.find(({ pattern }) => pattern.test(source));
  if (matchedCategory) return [matchedCategory.query];

  const stopWords = new Set([
    "original", "official", "latest", "terbaru", "untuk", "dengan", "dan",
    "the", "with", "for", "from", "anak", "wanita", "pria", "premium", "pcs"
  ]);
  const tokens = source.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const useful = [...new Set(tokens.filter((token) => !stopWords.has(token)))].slice(-3);
  return [useful.join(" ") || source.trim().slice(0, 100)];
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
 * Returns identity matches plus conservative category-only leads for manual
 * review. Category-only leads never become strong matches or publishable assets;
 * rights remain unverified and no media is downloaded.
 */
export async function searchWikimediaCommonsProductMedia(
  identity: ProductMediaSearchIdentity,
  options: WikimediaCommonsSearchOptions = {}
): Promise<ProductMediaCatalogCandidate[]> {
  const queries = buildWikimediaCommonsQueries(identity).map((query) => query.slice(0, 200));
  if (queries.length === 0) return [];

  const maxResults = options.maxResults ?? 10;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new Error("maxResults must be an integer between 1 and 20.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const candidates = new Map<string, ProductMediaCatalogCandidate>();
    for (const query of queries) {
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

      for (const page of pages) {
        const title = typeof page.title === "string" ? page.title.replace(/^File:/i, "").trim().slice(0, 1000) : "";
        const info = page.imageinfo?.[0];
        if (!title || !info) continue;

        const imageUrl = safeHttps(info.thumburl) ?? safeHttps(info.url);
        const landingPageUrl = safeHttps(info.descriptionurl);
        const mime = typeof info.mime === "string" ? info.mime.toLowerCase() : "";
        if (!imageUrl || !landingPageUrl || !mime.startsWith("image/")) continue;
        const imageHost = new URL(imageUrl).hostname;
        if (imageHost !== "upload.wikimedia.org" && imageHost !== "thumb.wikimedia.org") continue;
        if (new URL(landingPageUrl).hostname !== "commons.wikimedia.org") continue;

        const metadata = info.extmetadata;
        const licenseName = metadataText(metadata, "LicenseShortName");
        const licenseUrl = safeHttps(metadata?.LicenseUrl?.value);
        const acceptedLicense = normalizedLicense(licenseUrl, licenseName);
        if (!acceptedLicense) continue;

        const identityMatch = evaluateProductMediaIdentity(identity, title);
        const category = categoryQueries.find((item) => item.query === query);
        const descriptiveText = [title, metadataText(info.extmetadata, "Description"), metadataText(info.extmetadata, "ImageDescription")]
          .filter((value): value is string => Boolean(value))
          .join(" ");
        if (category && (!category.relevant.test(descriptiveText) || category.exclude?.test(descriptiveText))) continue;
        const primaryIdentifier = identity.model?.trim() || identity.sku?.trim();
        const categoryOnlyMatch = identityMatch.status === "rejected" && !primaryIdentifier && category !== undefined;
        if (identityMatch.status === "rejected" && !categoryOnlyMatch) continue;
        const creatorHref = metadata?.Artist?.value && typeof metadata.Artist.value === "string"
          ? metadata.Artist.value.match(/href=["']([^"']+)["']/i)?.[1]
          : null;
        const normalizedCreatorHref = creatorHref?.startsWith("//") ? `https:${creatorHref}` : creatorHref;

        const candidate: ProductMediaCatalogCandidate = {
          provider: "wikimedia_commons",
          title,
          imageUrl,
          landingPageUrl,
          creator: metadataText(metadata, "Artist"),
          creatorUrl: safeHttps(normalizedCreatorHref),
          license: acceptedLicense.license,
          licenseVersion: licenseName?.match(/\d+(?:\.\d+)?/)?.[0] ?? null,
          licenseUrl: acceptedLicense.licenseUrl,
          sourcePublisher: "Wikimedia Commons",
          identityScore: categoryOnlyMatch ? Math.max(20, Math.min(identityMatch.score, 49)) : identityMatch.score,
          identityStatus: categoryOnlyMatch ? "review_required" : identityMatch.status,
          identityReasons: categoryOnlyMatch
            ? [...identityMatch.reasons, `Kecocokan hanya pada tingkat kategori "${query}"; identitas produk tidak terbukti dan wajib diperiksa manusia.`]
            : [...identityMatch.reasons, "Kecocokan identitas produk memadai; hasil tetap wajib diperiksa manusia."],
          rightsStatus: "unverified"
        };
        candidates.set(landingPageUrl, candidate);
        if (candidates.size >= maxResults) break;
      }
      if (candidates.size >= maxResults) break;
    }
    return [...candidates.values()].sort((left, right) => right.identityScore - left.identityScore);
  } finally {
    clearTimeout(timeout);
  }
}
