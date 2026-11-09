import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicMediaUrl } from "./media-asset.js";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Transform, Readable } from "node:stream";

type Address = { address: string; family: 4 | 6 };
type RequestImpl = typeof httpsRequest;

export interface SafeStreamingFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolveHost?: typeof dnsLookup;
  requestImpl?: RequestImpl;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
    // 192.0.0.0/24 is special-purpose; only .9 and .10 are globally reachable
    // anycast exceptions in the IANA registry.
    const nonGlobalProtocolAssignment = a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 2) || (b === 88 && c === 99) || nonGlobalProtocolAssignment)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // Normalize textual IPv6 forms before prefix checks so expanded answers
  // cannot bypass special-use range detection.
  const normalized = new URL("https://[" + address + "]/").hostname.slice(1, -1).toLowerCase();
  // Allow only global-unicast 2000::/3; reject documentation, transition,
  // benchmarking, and other special-use IPv6 ranges.
  if (!/^[23]/.test(normalized)) return false;
  // IANA marks 2001::/23 as non-globally-reachable except for a few
  // narrowly allocated anycast/protocol prefixes. Media origins should not
  // resolve into that special-purpose block.
  if (normalized.startsWith("2001:")) {
    const secondHextet = normalized.split(":")[1] ?? "";
    const secondValue = secondHextet ? Number.parseInt(secondHextet, 16) : 0;
    if (Number.isFinite(secondValue) && secondValue < 0x0200) return false;
  }
  // 3fff::/20 is the current IPv6 documentation prefix.
  if (normalized.startsWith("3fff:") || normalized === "3fff") return false;
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8") return false;
  if (normalized.startsWith("2002:")) return false;
  return true;
}

function validateUrl(raw: string): URL {
  // Keep URL-shape checks identical to the domain-level media policy. DNS
  // resolution below still performs the authoritative address and redirect checks.
  if (!isPublicMediaUrl(raw)) {
    throw new Error("TikTok media source must be a credential-free public HTTPS URL.");
  }
  const url = new URL(raw);
  url.hash = "";
  return url;
}
async function resolvePublic(hostname: string, resolver: typeof dnsLookup, timeoutMs: number): Promise<Address> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("TikTok media DNS lookup exceeded the configured timeout.")),
          timeoutMs
        );
      })
    ]);
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new Error("TikTok media hostname resolves to a private or special-use address.");
    }
    const selected = addresses[0];
    if (!selected) throw new Error("TikTok media hostname has no usable address.");
    const family = isIP(selected.address);
    if (family !== 4 && family !== 6) {
      throw new Error("TikTok media hostname returned an invalid address.");
    }
    return { address: selected.address, family };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
function requestOnce(
  url: URL,
  address: Address,
  method: "HEAD" | "GET",
  maxBytes: number,
  timeoutMs: number,
  requestImpl: RequestImpl
): Promise<Response | { status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      // Prevent shared keep-alive sockets from bypassing this request's validated DNS lookup.
      agent: false,
      servername: url.hostname,
      headers: { "user-agent": "AffiliateOS TikTok media transfer", accept: "*/*" },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && typeof lookupOptions === "object" && "all" in lookupOptions && lookupOptions.all) {
          callback(null, [address]);
        } else {
          callback(null, address.address, address.family);
        }
      }
    };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const request = requestImpl(options, (incoming) => {
      incoming.once("end", clearDeadline);
      const status = incoming.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const location = incoming.headers.location;
        incoming.resume();
        resolve({ status, ...(typeof location === "string" ? { location } : {}) });
        return;
      }
      if (status < 200 || status >= 300 || (method === "GET" && (status === 204 || status === 205))) {
        incoming.resume();
        reject(new Error("TikTok media source returned HTTP " + status + " without a usable media body."));
        return;
      }
      const declaredLength = Number(incoming.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.destroy(new Error("TikTok media source exceeds the configured byte limit."));
        return;
      }
      if (method === "HEAD") {
        incoming.resume();
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        resolve(new Response(null, { status, headers }));
        return;
      }
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            callback(new Error("TikTok media source exceeds the configured byte limit."));
            request.destroy(new Error("TikTok media source exceeds the configured byte limit."));
            return;
          }
          callback(null, chunk);
        }
      });
      // IncomingMessage emits "close" both after normal completion and after an
      // interrupted response. Do not treat an incomplete close as success: surface
      // truncation to the consumer and stop the absolute deadline.
      incoming.once("close", () => {
        if (incoming.complete === false || !incoming.readableEnded) {
          clearDeadline();
          limiter.destroy(new Error("TikTok media source closed before the response completed."));
          return;
        }
        clearDeadline();
      });
      incoming.on("error", (error) => limiter.destroy(error));
      incoming.pipe(limiter);
      const nodeBody = Readable.toWeb(limiter) as ReadableStream<Uint8Array>;
      const nodeReader = nodeBody.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await nodeReader.read();
            if (next.done) {
              controller.close();
              nodeReader.releaseLock();
              return;
            }
            controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            try { nodeReader.releaseLock(); } catch { /* The reader may already be released. */ }
          }
        },
        async cancel(reason) {
          try {
            await nodeReader.cancel(reason);
          } finally {
            clearDeadline();
            try { nodeReader.releaseLock(); } catch { /* The reader may already be released. */ }
            if (!request.destroyed) request.destroy();
            if (!incoming.destroyed) incoming.destroy();
          }
        }
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(", "));
      }
      resolve(new Response(body, { status, headers }));
    });
    // Node's request.setTimeout is an inactivity timeout. Keep a separate absolute
    // deadline active through response streaming so slow-drip origins cannot hold
    // a media transfer open indefinitely while periodically sending small chunks.
    deadlineTimer = setTimeout(() => {
      request.destroy(new Error("TikTok media source exceeded the absolute transfer deadline."));
    }, timeoutMs);
    deadlineTimer.unref?.();
    request.setTimeout(timeoutMs, () => request.destroy(new Error("TikTok media source request timed out.")));
    request.on("error", (error) => {
      clearDeadline();
      reject(error);
    });
    request.end();
  });
}

/**
 * DNS-pinned streaming HTTPS fetch for TikTok FILE_UPLOAD. Redirects are
 * revalidated and video bytes are bounded while streaming, never buffered whole.
 */
export async function fetchPublicHttpsStream(
  rawUrl: string,
  init: { method: "HEAD" | "GET" },
  options: SafeStreamingFetchOptions
): Promise<Response> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("maxRedirects must be between 0 and 10.");
  }
  const resolver = options.resolveHost ?? dnsLookup;
  const requestImpl = options.requestImpl ?? httpsRequest;
  let current = validateUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const address = await resolvePublic(current.hostname, resolver, timeoutMs);
    const result = await requestOnce(current, address, init.method, options.maxBytes, timeoutMs, requestImpl);
    if (result instanceof Response) return result;
    if (redirects >= maxRedirects) throw new Error("TikTok media redirect limit exceeded.");
    if (!result.location) throw new Error("TikTok media redirect is missing a Location header.");
    current = validateUrl(new URL(result.location, current).toString());
  }
}
