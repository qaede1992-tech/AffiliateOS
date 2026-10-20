export interface SupabaseStorageConfig {
  supabaseUrl: string;
  serviceKey: string;
  bucket: string;
  fetchImpl?: typeof fetch;
}

export interface StoredObject {
  bucket: string;
  key: string;
}

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("Supabase Storage URL must use HTTPS.");
  }
  return parsed.toString().replace(/\/$/, "");
};

const validateSegment = (value: string, label: string): string => {
  const segment = value.trim();
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\\\") || /[\\u0000-\\u001f]/.test(segment)) {
    throw new Error(`Invalid Storage ${label}.`);
  }
  return segment;
};

const validateObjectKey = (key: string): string => {
  const segments = key.split("/");
  if (!key || key.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\\\"))) {
    throw new Error("Invalid Storage object key.");
  }
  return key;
};

/**
 * Minimal server-side Supabase Storage REST adapter.
 * Keep the service-role key on the API server only; never return it or log request headers.
 */
export class SupabaseStorageClient {
  private readonly baseUrl: string;
  private readonly bucket: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SupabaseStorageConfig) {
    this.baseUrl = normalizeBaseUrl(config.supabaseUrl);
    this.bucket = validateSegment(config.bucket, "bucket");
    this.serviceKey = config.serviceKey.trim();
    if (!this.serviceKey) throw new Error("Supabase Storage server credential is required.");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/storage/v1/${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, ...extra };
  }

  private async assertSuccess(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    // Deliberately do not include response body: upstream errors can contain sensitive details.
    throw new Error(`Supabase Storage ${operation} failed (HTTP ${response.status}).`);
  }

  async upload(input: { key: string; bytes: Uint8Array; contentType: string; upsert?: boolean }): Promise<StoredObject> {
    const key = validateObjectKey(input.key);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new Error("Storage upload must contain non-empty bytes.");
    if (!input.contentType.trim() || /[\\r\\n]/.test(input.contentType)) throw new Error("Invalid media content type.");
    const url = `${this.endpoint("object")}/${encodeURIComponent(this.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({
        "Content-Type": input.contentType,
        "x-upsert": input.upsert ? "true" : "false",
        "cache-control": "3600"
      }),
      body: input.bytes
    });
    await this.assertSuccess(response, "upload");
    return { bucket: this.bucket, key };
  }

  async remove(key: string): Promise<void> {
    const safeKey = validateObjectKey(key);
    const response = await this.fetchImpl(`${this.endpoint("object")}/${encodeURIComponent(this.bucket)}`, {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: [safeKey] })
    });
    await this.assertSuccess(response, "delete");
  }

  async createSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const safeKey = validateObjectKey(key);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 60 * 60) {
      throw new Error("Signed URL expiry must be between 1 and 3600 seconds.");
    }
    const objectPath = safeKey.split("/").map(encodeURIComponent).join("/");
    const response = await this.fetchImpl(`${this.endpoint("object/sign")}/${encodeURIComponent(this.bucket)}/${objectPath}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresInSeconds })
    });
    await this.assertSuccess(response, "signed URL creation");
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("signedURL" in payload) || typeof payload.signedURL !== "string") {
      throw new Error("Supabase Storage returned an invalid signed URL response.");
    }
    const signed = new URL(payload.signedURL, this.baseUrl);
    if (signed.protocol !== "https:" && signed.hostname !== "localhost" && signed.hostname !== "127.0.0.1") {
      throw new Error("Supabase Storage returned a non-HTTPS signed URL.");
    }
    if (signed.origin !== new URL(this.baseUrl).origin) throw new Error("Supabase Storage returned a URL for an unexpected origin.");
    return signed.toString();
  }
}

export const createSupabaseStorageClientFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): SupabaseStorageClient | undefined => {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_STORAGE_SERVICE_KEY?.trim();
  const bucket = env.SUPABASE_MEDIA_BUCKET?.trim();
  if (!supabaseUrl && !serviceKey && !bucket) return undefined;
  if (!supabaseUrl || !serviceKey || !bucket) {
    throw new Error("SUPABASE_URL, SUPABASE_STORAGE_SERVICE_KEY, and SUPABASE_MEDIA_BUCKET must be configured together.");
  }
  return new SupabaseStorageClient({ supabaseUrl, serviceKey, bucket, fetchImpl });
};
