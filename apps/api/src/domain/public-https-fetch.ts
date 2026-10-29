import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

export interface SafeHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Uint8Array;
}

export interface SafePublicHttpsFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof httpsRequest;
  resolveHost?: typeof dnsLookup;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS_DEFAULT = 3;
const TIMEOUT_DEFAULT_MS = 12_000;

const isPrivateOrSpecialIpv4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 0 && c === 0);
};

const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !isPrivateOrSpecialIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  // Only global-unicast 2000::/3 is allowed. This rejects loopback, link-local,
  // unique-local, IPv4-mapped, multicast, unspecified, and other special ranges.
  if (!/^[23]/.test(normalized)) return false;
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8") return false;
  if (normalized.startsWith("2001:") || normalized.startsWith("2002:")) return false;
  return true;
};

const validateUrl = (raw: string): URL => {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Only credential-free public HTTPS URLs are allowed.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local hostnames are not allowed.");
  }
  if (isIP(hostname)) throw new Error("IP literal URLs are not allowed.");
  url.hash = "";
  return url;
};

const resolvePublicAddress = async (hostname: string, resolver: typeof dnsLookup): Promise<{ address: string; family: number }> => {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Hostname resolves to a private or special-use address.");
  }
  const chosen = addresses[0];
  if (!chosen) throw new Error("Hostname has no usable address.");
  return chosen;
};

const requestOnce = async (
  url: URL,
  address: { address: string; family: number },
  maxBytes: number,
  timeoutMs: number,
  requestImpl: typeof httpsRequest
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; bytes: Uint8Array }> =>
  new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      headers: { Accept: "text/html,image/avif,image/webp,image/png,image/jpeg,video/mp4;q=0.8,*/*;q=0.1", "User-Agent": "AffiliateOS product media fetcher" },
      // Pin the request to the validated DNS answer to prevent a second DNS lookup
      // from being redirected to an internal address after validation.
      lookup: (_hostname, options, callback) => {
        if (options && typeof options === "object" && "all" in options && options.all) {
          callback(null, [address]);
        } else {
          callback(null, address.address, address.family);
        }
      }
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, headers, bytes: new Uint8Array() });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Public HTTPS request failed (HTTP ${status}).`));
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | Uint8Array) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          request.destroy(new Error("Public HTTPS response exceeds configured size limit."));
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });
      response.on("end", () => {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        resolve({ status, headers, bytes });
      });
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Public HTTPS request timed out.")));
    request.on("error", reject);
    request.end();
  });

/**
 * Fetches one public HTTPS resource while pinning validated DNS answers, manually
 * validating every redirect, bounding bytes and time, and never forwarding cookies.
 * This is not a browser and will not bypass access controls, CAPTCHA, or anti-bot checks.
 */
export const fetchPublicHttps = async (
  rawUrl: string,
  options: SafePublicHttpsFetchOptions
): Promise<SafeHttpResponse> => {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("maxBytes must be a positive safe integer.");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_DEFAULT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS_DEFAULT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive safe integer.");
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new Error("maxRedirects must be between 0 and 10.");
  const requestImpl = options.fetchImpl ?? httpsRequest;
  const resolver = options.resolveHost ?? dnsLookup;
  let current = validateUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const address = await resolvePublicAddress(current.hostname, resolver);
    const result = await requestOnce(current, address, options.maxBytes, timeoutMs, requestImpl);
    if (!REDIRECT_STATUSES.has(result.status)) {
      return { url: current.toString(), ...result };
    }
    if (redirects >= maxRedirects) throw new Error("Public HTTPS redirect limit exceeded.");
    const location = result.headers.location;
    if (typeof location !== "string" || !location.trim()) throw new Error("Redirect response is missing a valid Location header.");
    current = validateUrl(new URL(location, current).toString());
  }
};
