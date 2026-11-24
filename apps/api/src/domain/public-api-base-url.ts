import { z } from "zod";

/**
 * Canonical externally reachable HTTPS origin used when providers fetch
 * locally-served publication media. Never derive this value from request
 * headers or the API bind address.
 */
export const publicApiBaseUrlSchema = z.string().trim().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash;
  } catch {
    return false;
  }
}, {
  message: "PUBLIC_API_BASE_URL must be an HTTPS URL without credentials, query, or fragment."
});

export function normalizePublicApiBaseUrl(value: string): string {
  const parsed = publicApiBaseUrlSchema.parse(value);
  return parsed.replace(/\/+$/, "");
}
