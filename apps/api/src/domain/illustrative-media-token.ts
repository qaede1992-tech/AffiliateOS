import { createHmac, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 2048;

export interface IllustrativeMediaTokenClaims {
  creativeId: string;
  mediaAssetId: string;
  contentId: string;
  sha256: string;
  /** Null means lifecycle-revoked: access is revoked by terminal DB state, not a guessed provider TTL. */
  expiresAtSeconds: number | null;
}
export type IllustrativeMediaTokenExpectedContext = Omit<IllustrativeMediaTokenClaims, "expiresAtSeconds">;

export class IllustrativeMediaTokenSigner {
  private readonly secret: Buffer;
  constructor(secret: string | Uint8Array) {
    this.secret = Buffer.from(secret);
    if (this.secret.byteLength < 32) throw new Error("Illustrative media signing secret must contain at least 32 bytes.");
  }
  sign(claims: IllustrativeMediaTokenClaims, nowSeconds = Math.floor(Date.now() / 1000)): string {
    this.validateClaims(claims);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
        (claims.expiresAtSeconds !== null && claims.expiresAtSeconds <= nowSeconds)) {
      throw new Error("Illustrative media token expiry must be future or lifecycle-revoked.");
    }
    const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString("base64url");
    return `${payload}.${this.signature(payload).toString("base64url")}`;
  }
  verify(token: string, expected: IllustrativeMediaTokenExpectedContext, nowSeconds = Math.floor(Date.now() / 1000)): IllustrativeMediaTokenClaims {
    try {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new Error("invalid");
      const parts = token.split(".");
      if (parts.length !== 2 || !parts.every((part) => TOKEN_SEGMENT.test(part))) throw new Error("invalid");
      const [payload, encodedSignature] = parts as [string, string];
      const actualSignature = Buffer.from(encodedSignature, "base64url");
      if (actualSignature.toString("base64url") !== encodedSignature) throw new Error("invalid");
      const decodedPayload = Buffer.from(payload, "base64url");
      if (decodedPayload.toString("base64url") !== payload) throw new Error("invalid");
      const expectedSignature = this.signature(payload);
      if (actualSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actualSignature, expectedSignature)) throw new Error("invalid");
      const parsed = JSON.parse(decodedPayload.toString("utf8")) as Record<string, unknown>;
      if (parsed.v !== 1) throw new Error("invalid");
      const claims: IllustrativeMediaTokenClaims = {
        creativeId: parsed.creativeId as string,
        mediaAssetId: parsed.mediaAssetId as string,
        contentId: parsed.contentId as string,
        sha256: parsed.sha256 as string,
        expiresAtSeconds: parsed.expiresAtSeconds as number | null
      };
      this.validateClaims(claims);
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
          (claims.expiresAtSeconds !== null && claims.expiresAtSeconds <= nowSeconds)) throw new Error("invalid");
      if (claims.creativeId !== expected.creativeId || claims.mediaAssetId !== expected.mediaAssetId ||
          claims.contentId !== expected.contentId || claims.sha256 !== expected.sha256) throw new Error("invalid");
      return claims;
    } catch {
      throw new Error("Invalid or expired illustrative media token.");
    }
  }
  private signature(payload: string): Buffer { return createHmac("sha256", this.secret).update(payload, "utf8").digest(); }
  private validateClaims(claims: IllustrativeMediaTokenClaims): void {
    if (!UUID.test(claims.creativeId) || !UUID.test(claims.mediaAssetId) || !UUID.test(claims.contentId) ||
        !SHA256.test(claims.sha256) ||
        (claims.expiresAtSeconds !== null && (!Number.isSafeInteger(claims.expiresAtSeconds) || claims.expiresAtSeconds <= 0))) {
      throw new Error("Illustrative media token claims are invalid.");
    }
  }
}
