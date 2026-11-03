/**
 * Openverse catalog search adapter and conservative product-identity matcher.
 *
 * Search results are discovery leads only. This module never downloads media,
 * grants usage rights, or marks assets publishable. A human rights review and
 * persisted evidence are still required by product-media-publication-rights.
 */
export interface ProductMediaSearchIdentity {
  name: string;
  brand?: string | null;
  model?: string | null;
  sku?: string | null;
  variant?: string | null;
}

export interface ProductMediaCatalogCandidate {
  provider: "openverse";
  title: string;
  imageUrl: string;
  landingPageUrl: string;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseVersion: string | null;
  licenseUrl: string | null;
  sourcePublisher: string | null;
  identityScore: number;
  identityStatus: "strong_match" | "review_required" | "rejected";
  identityReasons: string[];
  rightsStatus: "unverified";
}

export interface ProductMediaCatalogSearchOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxResults?: number;
}

const normalize = (value: string): string => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const terms = (value: string): Set<string> => new Set(
  normalize(value).split(" ").filter((part) => part.length >= 2)
);

const hasExactIdentifier = (candidate: string, identifier: string): boolean => {
  const normalizedCandidate = normalize(candidate);
  const normalizedIdentifier = normalize(identifier);
  if (!normalizedIdentifier) return false;
  return ` ${normalizedCandidate} `.includes(` ${normalizedIdentifier} `);
};

const overlap = (expected: Set<string>, actual: Set<string>): number => {
  if (expected.size === 0) return 0;
  let matched = 0;
  for (const token of expected) if (actual.has(token)) matched++;
  return matched / expected.size;
};

/** Builds a bounded, descriptive query without embedding marketplace URLs. */
export const buildProductMediaSearchQuery = (identity: ProductMediaSearchIdentity): string => {
  const parts = [identity.brand, identity.name, identity.model, identity.sku, identity.variant]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return [...new Set(parts.map((part) => part.trim()))].join(" ").slice(0, 200);
};

/**
 * Model/SKU mismatches are hard rejects. A strong result needs a model/SKU
 * identifier match or a high title overlap with a matching brand. Similarity
 * alone is never treated as proof that two product variants are identical.
 */
export const evaluateProductMediaIdentity = (
  identity: ProductMediaSearchIdentity,
  candidateTitle: string
): { score: number; status: ProductMediaCatalogCandidate["identityStatus"]; reasons: string[] } => {
  const expectedText = [identity.brand, identity.name, identity.model, identity.sku, identity.variant]
    .filter((value): value is string => Boolean(value?.trim())).join(" ");
  const actualTokens = terms(candidateTitle);
  const expectedTokens = terms(expectedText);
  const reasons: string[] = [];

  // Prefer the manufacturer's model identifier; use SKU only when no model exists.
  const primaryIdentifier = identity.model?.trim() || identity.sku?.trim();
  const identifierMatches = primaryIdentifier
    ? hasExactIdentifier(candidateTitle, primaryIdentifier)
    : false;
  if (primaryIdentifier && !identifierMatches) {
    return { score: 0, status: "rejected", reasons: ["Model/SKU tidak cocok dengan identitas produk."] };
  }
  if (identifierMatches) reasons.push("Model atau SKU cocok secara tekstual.");

  const brand = identity.brand?.trim();
  const brandMatches = !brand || hasExactIdentifier(candidateTitle, brand);
  if (brand && brandMatches) reasons.push("Merek cocok secara tekstual.");
  if (brand && !brandMatches) reasons.push("Merek tidak ditemukan pada judul hasil.");

  const variant = identity.variant?.trim();
  const variantMatches = !variant || hasExactIdentifier(candidateTitle, variant);
  if (variant && variantMatches) reasons.push("Varian cocok secara tekstual.");
  if (variant && !variantMatches) reasons.push("Varian tidak ditemukan pada judul hasil.");

  const titleScore = overlap(expectedTokens, actualTokens);
  if (titleScore > 0) reasons.push(`Kemiripan token identitas: ${Math.round(titleScore * 100)}%.`);
  const score = Math.round(Math.min(1, titleScore * 0.55 + (brandMatches && brand ? 0.15 : 0) + (identifierMatches ? 0.35 : 0) + (variantMatches && variant ? 0.1 : 0)) * 100);

  if (primaryIdentifier && identifierMatches && brandMatches && variantMatches) {
    return { score: Math.max(score, 90), status: "strong_match", reasons };
  }
  if (primaryIdentifier && identifierMatches && brandMatches && variant && !variantMatches) {
    return { score, status: "review_required", reasons: [...reasons, "Model cocok, tetapi varian belum terbukti cocok; perlu pemeriksaan manual."] };
  }
  if (!primaryIdentifier && brandMatches && titleScore >= 0.65) {
    return {
      score: Math.max(score, Math.round(titleScore * 100)),
      status: "review_required",
      reasons: [...reasons, "Kecocokan judul saja tidak membuktikan model atau varian; wajib diperiksa manusia."]
    };
  }
  return { score, status: "rejected", reasons: [...reasons, "Kecocokan identitas belum cukup kuat."] };
};

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

interface OpenverseImage {
  title?: unknown;
  url?: unknown;
  foreign_landing_url?: unknown;
  creator?: unknown;
  creator_url?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  source?: unknown;
}

interface OpenverseResponse {
  results?: OpenverseImage[];
}

/**
 * Searches Openverse's documented public API for commercially usable,
 * modification-permitting license families. Rights remain unverified because
 * catalog metadata is not a substitute for checking the originating license.
 */
export async function searchOpenverseProductMedia(
  identity: ProductMediaSearchIdentity,
  options: ProductMediaCatalogSearchOptions = {}
): Promise<ProductMediaCatalogCandidate[]> {
  const query = buildProductMediaSearchQuery(identity);
  if (!query) return [];
  const maxResults = options.maxResults ?? 20;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    throw new Error("maxResults must be an integer between 1 and 20.");
  }

  const endpoint = new URL(options.endpoint ?? "https://api.openverse.org/v1/images/");
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.openverse.org") {
    throw new Error("Openverse endpoint must use the official api.openverse.org HTTPS host.");
  }
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("page_size", String(maxResults));
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("filter_dead", "true");
  endpoint.searchParams.set("license", "cc0,pdm,by,by-sa");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Openverse search failed with HTTP ${response.status}.`);
    const payload = await response.json() as OpenverseResponse;
    if (!Array.isArray(payload.results)) return [];

    return payload.results.slice(0, maxResults).flatMap((item) => {
      const title = typeof item.title === "string" ? item.title.trim().slice(0, 1000) : "";
      const imageUrl = safeHttps(item.url);
      const landingPageUrl = safeHttps(item.foreign_landing_url);
      const license = typeof item.license === "string" ? item.license.toLowerCase() : null;
      // Re-check the license allow-list locally; never trust a provider filter alone.
      if (!title || !imageUrl || !landingPageUrl || !license || !["cc0", "pdm", "by", "by-sa"].includes(license)) return [];
      const identityMatch = evaluateProductMediaIdentity(identity, title);
      if (identityMatch.status === "rejected") return [];
      return [{
        provider: "openverse" as const,
        title,
        imageUrl,
        landingPageUrl,
        creator: typeof item.creator === "string" ? item.creator.slice(0, 500) : null,
        creatorUrl: safeHttps(item.creator_url),
        license,
        licenseVersion: typeof item.license_version === "string" ? item.license_version.slice(0, 40) : null,
        licenseUrl: safeHttps(item.license_url),
        sourcePublisher: typeof item.source === "string" ? item.source.slice(0, 255) : null,
        identityScore: identityMatch.score,
        identityStatus: identityMatch.status,
        identityReasons: identityMatch.reasons,
        rightsStatus: "unverified" as const
      }];
    }).sort((left, right) => right.identityScore - left.identityScore);
  } finally {
    clearTimeout(timeout);
  }
}
