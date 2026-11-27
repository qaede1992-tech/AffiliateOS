import { createHmac, timingSafeEqual } from "node:crypto";

export interface ProductMediaPreviewClaims {
  version: 1;
  assetId: string;
  productId: string;
  sha256: string;
  expiresAt: number;
}
export interface ProductMediaPreviewTokenConfig {
  signingKey: string;
  maximumLifetimeSeconds: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest();

function assertClaims(value: unknown): asserts value is ProductMediaPreviewClaims {
  if (!value || typeof value !== "object") throw new Error("Invalid product media preview token.");
  const claims = value as Record<string, unknown>;
  if (claims.version !== 1 ||
      typeof claims.assetId !== "string" || !UUID.test(claims.assetId) ||
      typeof claims.productId !== "string" || !UUID.test(claims.productId) ||
      typeof claims.sha256 !== "string" || !SHA256.test(claims.sha256) ||
      typeof claims.expiresAt !== "number" || !Number.isSafeInteger(claims.expiresAt)) {
    throw new Error("Invalid product media preview token.");
  }
}
function assertConfig(config: ProductMediaPreviewTokenConfig) {
  if (config.signingKey.trim().length < 32) throw new Error("Product media preview signing key must contain at least 32 characters.");
  if (!Number.isSafeInteger(config.maximumLifetimeSeconds) || config.maximumLifetimeSeconds < 1 || config.maximumLifetimeSeconds > 900) {
    throw new Error("Product media preview token lifetime must be between 1 and 900 seconds.");
  }
}
export function createProductMediaPreviewToken(
  claims: Omit<ProductMediaPreviewClaims, "version">,
  config: ProductMediaPreviewTokenConfig,
  now = Date.now()
): string {
  assertConfig(config);
  const normalized: ProductMediaPreviewClaims = { version: 1, ...claims };
  assertClaims(normalized);
  const nowSeconds = Math.floor(now / 1000);
  if (normalized.expiresAt <= nowSeconds || normalized.expiresAt > nowSeconds + config.maximumLifetimeSeconds) {
    throw new Error("Product media preview token expiry is outside the permitted lifetime.");
  }
  const payload = encode(JSON.stringify(normalized));
  return `${payload}.${sign(payload, config.signingKey).toString("base64url")}`;
}
export function verifyProductMediaPreviewToken(
  token: string,
  config: ProductMediaPreviewTokenConfig,
  now = Date.now()
): ProductMediaPreviewClaims {
  assertConfig(config);
  if (typeof token !== "string" || token.length > 2048) throw new Error("Invalid product media preview token.");
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) {
    throw new Error("Invalid product media preview token.");
  }
  const expected = sign(parts[0]!, config.signingKey);
  const supplied = Buffer.from(parts[1]!, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid product media preview token.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid product media preview token."); }
  assertClaims(parsed);
  if (parsed.expiresAt <= Math.floor(now / 1000)) throw new Error("Product media preview token has expired.");
  return parsed;
}
