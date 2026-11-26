import type { IllustrativeMediaTokenSigner } from "./illustrative-media-token.js";
import { parseSingleByteRange } from "./byte-range.js";

export type IllustrativeCreativeRecord = {
  id: string; mediaAssetId: string; contentId: string; platform: string; sha256: string;
  mimeType: string; byteSize: number; disclosureEmbedded: boolean; reviewStatus: string;
  storageBackend: string | null; storageKey: string | null;
  productId?: string; affiliateOfferId?: string | null; rendererVersion?: string; templateVersion?: string;
  productSnapshot?: Record<string, unknown>; widthPx?: number; heightPx?: number; durationMs?: number;
};
export type IllustrativeDispatchReservation = { state: string; provider: string; contentId: string };
export interface IllustrativeCreativeReader { findById(id: string): Promise<IllustrativeCreativeRecord | undefined>; findByMediaAssetId?(id: string): Promise<IllustrativeCreativeRecord | undefined>; }
export interface IllustrativePolicyReader {
  isEnabled(platform: "instagram"): Promise<boolean>;
  getPolicy?(platform: "instagram"): Promise<{ platform: "instagram"; enabled: boolean; terms: Record<string, unknown> } | undefined>;
}
export interface IllustrativeDispatchReader { findActiveByContentProvider(contentId: string, provider: "instagram-graph"): Promise<IllustrativeDispatchReservation | undefined>; }
export interface IllustrativeFileReader {
  get(input: { key: string; expectedSha256: string; expectedByteSize: number }): Promise<Uint8Array>;
}
export type IllustrativeMediaResponse = {
  status: 200 | 206 | 416; mimeType: "video/mp4"; byteSize: number; contentRange?: string;
  bytes?: Uint8Array; acceptRanges: "bytes";
};

const ACTIVE_DISPATCH_STATES = new Set(["dispatching", "accepted", "uncertain", "needs_reconciliation"]);
const unavailable = () => new Error("Illustrative media is not available.");

export class IllustrativeMediaDeliveryService {
  constructor(private readonly dependencies: {
    creatives: IllustrativeCreativeReader;
    policies: IllustrativePolicyReader;
    dispatches: IllustrativeDispatchReader;
    files: IllustrativeFileReader;
    signer: IllustrativeMediaTokenSigner;
  }) {}

  /** Resolve a generated creative from the exact media asset selected by the publisher. */
  async issueTokenForMediaAsset(mediaAssetId: string, contentId: string): Promise<{ creativeId: string; token: string }> {
    const creative = await this.dependencies.creatives.findByMediaAssetId?.(mediaAssetId);
    if (!creative || creative.mediaAssetId !== mediaAssetId || creative.contentId !== contentId ||
        !this.isDeliverableCreative(creative)) throw unavailable();
    if (!await this.dependencies.policies.isEnabled("instagram")) throw unavailable();
    await this.requireActiveDispatch(creative.contentId);
    return { creativeId: creative.id, token: this.signCreative(creative) };
  }

  /** Called by the trusted publisher resolver before it sends the URL to Meta. */
  async issueToken(creativeId: string): Promise<string> {
    const creative = await this.dependencies.creatives.findById(creativeId);
    if (!creative || creative.id !== creativeId || !this.isDeliverableCreative(creative)) throw unavailable();
    if (!await this.dependencies.policies.isEnabled("instagram")) throw unavailable();
    await this.requireActiveDispatch(creative.contentId);
    return this.signCreative(creative);
  }

  private signCreative(creative: IllustrativeCreativeRecord): string {
    return this.dependencies.signer.sign({
      creativeId: creative.id, mediaAssetId: creative.mediaAssetId, contentId: creative.contentId,
      sha256: creative.sha256, expiresAtSeconds: null
    });
  }

  /** Each GET/HEAD rechecks durable lifecycle state; terminal reservations revoke old URLs. */
  async read(input: { creativeId: string; token: string; range?: string; head?: boolean }): Promise<IllustrativeMediaResponse> {
    const creative = await this.dependencies.creatives.findById(input.creativeId);
    if (!creative || creative.id !== input.creativeId || !this.isDeliverableCreative(creative)) throw unavailable();
    this.dependencies.signer.verify(input.token, {
      creativeId: creative.id, mediaAssetId: creative.mediaAssetId,
      contentId: creative.contentId, sha256: creative.sha256
    });
    // Policy revocation must invalidate already-issued provider URLs as well.
    if (!await this.dependencies.policies.isEnabled("instagram")) throw unavailable();
    await this.requireActiveDispatch(creative.contentId);
    const parsed = parseSingleByteRange(input.range, creative.byteSize);
    if (parsed.kind === "unsatisfiable") {
      return { status: 416, mimeType: "video/mp4", byteSize: creative.byteSize,
        contentRange: `bytes */${creative.byteSize}`, acceptRanges: "bytes" };
    }
    const full = input.head ? undefined : await this.dependencies.files.get({
      key: creative.storageKey!, expectedSha256: creative.sha256, expectedByteSize: creative.byteSize
    });
    if (parsed.kind === "partial") {
      return { status: 206, mimeType: "video/mp4", byteSize: parsed.length,
        contentRange: `bytes ${parsed.start}-${parsed.end}/${creative.byteSize}`,
        bytes: full?.slice(parsed.start, parsed.end + 1), acceptRanges: "bytes" };
    }
    return { status: 200, mimeType: "video/mp4", byteSize: creative.byteSize, bytes: full, acceptRanges: "bytes" };
  }

  private isDeliverableCreative(value: IllustrativeCreativeRecord): boolean {
    return value.platform === "instagram" && value.mimeType === "video/mp4" &&
      value.disclosureEmbedded === true && value.reviewStatus === "approved" &&
      value.storageBackend === "local_volume" && typeof value.storageKey === "string" &&
      value.storageKey.length > 0 && Number.isSafeInteger(value.byteSize) && value.byteSize > 0;
  }

  private async requireActiveDispatch(contentId: string): Promise<void> {
    const reservation = await this.dependencies.dispatches.findActiveByContentProvider(contentId, "instagram-graph");
    if (!reservation || reservation.provider !== "instagram-graph" || reservation.contentId !== contentId ||
        !ACTIVE_DISPATCH_STATES.has(reservation.state)) throw unavailable();
  }
}
