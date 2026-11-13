import { isPublicMediaUrl } from "./media-asset.js";
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
  if (typeof value !== "string" || value.length > 2048 || !isPublicMediaUrl(value)) return null;
  try { return new URL(value).toString(); } catch { return null; }
};

const safeCreativeCommonsLicenseUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname.toLowerCase() !== "creativecommons.org" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "80" && url.port !== "443")
    ) return null;
    url.protocol = "https:";
    url.port = "";
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
  { pattern: /\b(?:rak|holder|organizer|organiser|stand|storage|tray)\b.{0,40}\b(lipstick|makeup|cosmetic)\b|\b(lipstick|makeup|cosmetic)\b.{0,40}\b(?:rak|holder|organizer|organiser|stand|storage|tray)\b/i, query: "lipstick holder", relevant: /\b(lipstick holder|lipstick organizer|lipstick stand|makeup organizer|cosmetic organizer|makeup storage|lipstick storage)\b/i, exclude: /\b(lipstick tube|lipstick product|lipstick bottle|makeup brush)\b/i },
  { pattern: /\b(keranjang|colander|strainer|tirisan|saringan sayuran|vegetable strainer)\b/i, query: "colander", relevant: /\b(colander|strainer|draining basket|vegetable strainer|food strainer)\b/i },
  { pattern: /\b(food container|food storage|kontainer|kotak penyimpanan makanan|wadah makanan)\b/i, query: "food container", relevant: /\b(food container|food storage container|plastic food container|kitchen storage container)\b/i },
  { pattern: /\b(blood pressure monitor|wrist blood pressure|tensimeter|sphygmomanometer|omron hem)\b/i, query: "blood pressure monitor", relevant: /\b(blood pressure monitor|blood pressure monitoring|sphygmomanometer)\b/i },
  { pattern: /\b(label printer|printer label|niimbot|thermal label printer)\b/i, query: "label printer", relevant: /\b(label printer|label maker|thermal printer|label scanner)\b/i },
  { pattern: /\b(sneakers|sneaker|sepatu sneakers|sepatu olahraga)\b/i, query: "sneakers", relevant: /\b(sneaker|sneakers|athletic shoe|running shoe)\b/i },


  { pattern: /\b(sweater|sweatshirt|hoodie|blouse|polo shirt|gamis|dress|celana|pakaian|hijab|jilbab|bergo|sling bag|tas wanita|dompet|topi baseball|baseball cap|kaos kaki|socks|sandal|kacamata hitam)\b/i, query: "clothing and fashion accessories", relevant: /\b(sweater|sweatshirt|hoodie|blouse|polo shirt|dress|pants|trousers|hijab|headscarf|bag|wallet|cap|hat|socks|sandal|sunglasses|eyeglasses)\b/i },
  { pattern: /\b(aksesoris mobil|pengait kargo|injector cleaner|car phone holder|jaring taruh hp)\b/i, query: "automotive accessories", relevant: /\b(car phone holder|phone holder|car accessory|automotive accessory|cargo hook|motorcycle accessory|vehicle)\b/i },
  { pattern: /\b(aquascape|aquarium|filter gantung aquarium|aquarium mini)\b/i, query: "aquarium equipment", relevant: /\b(aquarium|aquascape|aquarium filter|fish tank|aquatic tank)\b/i },
  { pattern: /\b(milk powder|powdered milk|susu kuda|susu kambing|horse milk|goat milk|susu bubuk)\b/i, query: "milk powder", relevant: /\b(milk powder|powdered milk|goat milk|horse milk|dairy powder)\b/i },
  { pattern: /\b(baso aci|bakso|snack|cokelat|chocolate|cadbury|alpukat|avocado|beras|rice)\b/i, query: "food product", relevant: /\b(food product|packaged food|snack|chocolate|cocoa|avocado|rice|meatball|baso|food packaging)\b/i },
  { pattern: /\b(meal replacement|protein shake|gummy vitamin|vitamin c|vit c|vitamin d|vit d3|vitamin|supplement|suplemen|herbal diet)\b/i, query: "dietary supplement product", relevant: /\b(dietary supplement|vitamin supplement|vitamin c|vitamin d|vit c|vit d|protein powder|meal replacement|supplement bottle)\b/i },
  { pattern: /\b(teh|tea|kopi|coffee)\b/i, query: "tea and coffee", relevant: /\b(tea|tea leaves|tea bag|coffee|coffee beans|ground coffee)\b/i },
  { pattern: /\b(sikat sepatu|pembersih sepatu|tissue pembersih sepatu|shoe brush|shoe cleaner)\b/i, query: "shoe cleaning brush", relevant: /\b(shoe brush|shoe cleaning|shoe cleaner|shoe polish brush)\b/i },
  { pattern: /\b(masker duckbill|facemask|face mask|masker wajah|masker medis)\b/i, query: "protective face mask", relevant: /\b(face mask|facemask|surgical mask|protective mask|respirator)\b/i },
  { pattern: /\b(tisu wajah|tissue|tisu|paper towel)\b/i, query: "facial tissue", relevant: /\b(facial tissue|tissue paper|paper tissue|paper towel)\b/i },
  { pattern: /\b(filter kran|water filter|saringan air)\b/i, query: "water faucet filter", relevant: /\b(water filter|faucet filter|tap filter|water purifier filter)\b/i },
  { pattern: /\b(deodorant|deodoran|antiperspirant|tawas spray)\b/i, query: "deodorant", relevant: /\b(deodorant|antiperspirant|underarm deodorant)\b/i },
  { pattern: /\b(detergent|deterjen|rinso|sabun cuci piring|dish soap|sabun mandi|bar soap)\b/i, query: "household cleaning products", relevant: /\b(detergent|dish soap|dishwashing liquid|bar soap|laundry detergent|cleaning product)\b/i },
  { pattern: /\b(perfume|parfum|fragrance|body mist|cologne)\b/i, query: "perfume bottle", relevant: /\b(perfume|fragrance|cologne|body mist|perfume bottle)\b/i },
  { pattern: /\b(lipstick|lip cream|lip balm|lip tint|makeup|skincare|toner|sunscreen)\b/i, query: "cosmetics and skincare", relevant: /\b(cosmetic|makeup|lipstick|lip balm|lip cream|skincare|sunscreen|skin care product|toner)\b/i },
  { pattern: /\b(bulu mata|eyelash|false eyelashes)\b/i, query: "false eyelashes", relevant: /\b(false eyelashes|eyelashes|eyelash extensions|artificial eyelashes)\b/i },
  { pattern: /\b(rak susun|rak penyimpanan|storage rack|organizer|troli plastik)\b/i, query: "household storage rack", relevant: /\b(storage rack|shelving|shelf|organizer|storage trolley)\b/i },
  { pattern: /\b(keset|floor mat|keset lantai)\b/i, query: "floor mat", relevant: /\b(floor mat|doormat|door mat|bath mat)\b/i },
  { pattern: /\b(pampers|mamypoko|diaper|popok)\b/i, query: "baby diaper", relevant: /\b(baby diaper|diaper|nappy)\b/i },
  { pattern: /\b(marker|spidol|permanent marker)\b/i, query: "permanent marker pen", relevant: /\b(permanent marker|marker pen|felt-tip pen)\b/i },
  { pattern: /\b(shampoo|shampo|hair shampoo)\b/i, query: "shampoo bottle", relevant: /\b(shampoo|shampoo bottle|hair care)\b/i },
  { pattern: /\b(kipas angin|electric fan|fan 3in1)\b/i, query: "electric fan", relevant: /\b(electric fan|desk fan|standing fan|pedestal fan)\b/i },
  { pattern: /\b(panci|cookware|mangkuk ramen|wajan|frying pan)\b/i, query: "cookware", relevant: /\b(cookware|saucepan|cooking pot|frying pan|wok|stainless steel pot)\b/i },
  { pattern: /\b(sarung tangan plastik|disposable gloves|gloves)\b/i, query: "disposable gloves", relevant: /\b(disposable gloves|plastic gloves|nitrile gloves|latex gloves)\b/i },
  { pattern: /\b(backpack|rucksack|ransel|tas sekolah|tas kuliah)\b/i, query: "backpack", relevant: /\b(backpack|rucksack|knapsack|school bag)\b/i },
  { pattern: /\b(botol minum|tumbler|termos|water bottle)\b/i, query: "water bottle", relevant: /\b(water bottle|bottle|thermos|flask|canteen)\b/i },
  { pattern: /\b(charger|pengisi daya|fast charging)\b/i, query: "charger", relevant: /\b(charger|charging adapter|power adapter)\b/i },
  { pattern: /\b(brown sugar|gula merah|gula aren|gula tebu)\b/i, query: "brown sugar", relevant: /\b(brown sugar|palm sugar|jaggery)\b/i, exclude: /\b(making of|production of|factory|harvest|field)\b/i },
  { pattern: /\b(cat food|makanan kucing|pakan kucing)\b/i, query: "cat food", relevant: /\b(cat food|kibble|cat kibble|dry cat food)\b/i, exclude: /\b(donation|donation box|donation booth|shelter|charity|feeding program|wet (?:cat )?food)\b/i },
  { pattern: /\b(baby cream|krim bayi|baby lotion|perlengkapan bayi)\b/i, query: "baby cream", relevant: /\b(baby cream|barrier cream|skin cream|lotion|moisturizer|ointment|skincare)\b/i },
  { pattern: /\b(hand soap|hand wash|sabun cuci tangan)\b/i, query: "hand soap", relevant: /\b(hand soap|hand wash|liquid soap|soap dispenser|handwashing)\b/i },
  { pattern: /\b(honey|madu)\b/i, query: "honey", relevant: /\b(honey|honeycomb|honey jar|bee honey)\b/i, exclude: /\b(honey buzzard|buzzard|wildlife|birds?)\b/i },
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

  const categorySource = identity.category?.trim() ?? "";
  const matchedCategory = categoryQueries.find(({ pattern }) => pattern.test(source) || (categorySource.length > 0 && pattern.test(categorySource)));
  if (matchedCategory) return [matchedCategory.query];

  const stopWords = new Set([
    "original", "official", "latest", "terbaru", "untuk", "dengan", "dan",
    "the", "with", "for", "from", "anak", "wanita", "pria", "premium", "pcs"
  ]);
  const tokens = source.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const listingNoise = new Set(["rak", "tempat", "meja", "slot", "top", "type", "fast", "charging", "original", "official", "latest", "terbaru", "premium", "pcs", "box", "set"]);
  const useful = [...new Set(tokens.filter((token) => !stopWords.has(token) && !listingNoise.has(token) && !/^[a-z]{2,}\d+[a-z0-9]*$/i.test(token)))].slice(0, 3);
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
 * Returns identity matches plus category-relevant leads for mandatory human review.
 * Category relevance never proves product identity: weak matches stay pending and
 * rights remain unverified. This module never imports or downloads media.
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
        const licenseUrl = safeCreativeCommonsLicenseUrl(metadata?.LicenseUrl?.value);
        const acceptedLicense = normalizedLicense(licenseUrl, licenseName);
        if (!acceptedLicense) continue;

        const identityMatch = evaluateProductMediaIdentity(identity, title);
        const category = categoryQueries.find((item) => item.query === query);
        const descriptiveText = [title, metadataText(info.extmetadata, "Description"), metadataText(info.extmetadata, "ImageDescription")]
          .filter((value): value is string => Boolean(value))
          .join(" ");
        if (category && (!category.relevant.test(descriptiveText) || category.exclude?.test(descriptiveText))) continue;

        // A category-only match is useful as a discovery lead, not as proof of
        // identity. Preserve it solely in the pending administrator review queue.
        // The import path separately requires an explicit admin approval and
        // fresh non-media eligibility evidence; rights remain unverified.
        const identityStatus = identityMatch.status === "rejected" && category
          ? "review_required" as const
          : identityMatch.status;
        if (identityStatus === "rejected") continue;
        const identityScore = identityMatch.status === "rejected"
          ? Math.max(identityMatch.score, 20)
          : identityMatch.score;
        const identityReasons = identityMatch.status === "rejected"
          ? [
              ...identityMatch.reasons,
              `Hasil hanya cocok pada kategori "${category!.query}"; identitas produk belum terbukti dan wajib diperiksa manusia.`
            ]
          : identityMatch.reasons;
        const creatorHref = metadata?.Artist?.value && typeof metadata.Artist.value === "string"
          ? metadata.Artist.value.match(/href=["']([^"']+)["']/i)?.[1]
          : null;
        const normalizedCreatorHref = creatorHref?.startsWith("//") ? `https:${creatorHref}` : creatorHref;

        const candidate: ProductMediaCatalogCandidate = {
          provider: "wikimedia_commons",
          searchQuery: query,
          title,
          imageUrl,
          landingPageUrl,
          creator: metadataText(metadata, "Artist"),
          creatorUrl: safeHttps(normalizedCreatorHref),
          license: acceptedLicense.license,
          licenseVersion: licenseName?.match(/\d+(?:\.\d+)?/)?.[0] ?? null,
          licenseUrl: acceptedLicense.licenseUrl,
          sourcePublisher: "Wikimedia Commons",
          identityScore,
          identityStatus,
          identityReasons: [
            ...identityReasons,
            "Semua kandidat tetap pending; pemeriksaan identitas dan hak penggunaan oleh administrator wajib dilakukan sebelum impor."
          ],
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
