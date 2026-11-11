import type { OpenverseHttpFailureDetails } from "./product-media-catalog-search.js";

const OPENVERSE_FORBIDDEN_COOLDOWN_MS = 6 * 60 * 60_000;
let forbiddenUntil = 0;

export class OpenverseCircuitOpenError extends Error {
  constructor(readonly retryAt: string) {
    super("Openverse provider is temporarily paused after HTTP 403.");
    this.name = "OpenverseCircuitOpenError";
  }
}

/** A provider-wide pause prevents different products from repeating a known 403. */
export const assertOpenverseAvailable = (now = Date.now()): void => {
  if (forbiddenUntil <= now) {
    forbiddenUntil = 0;
    return;
  }
  throw new OpenverseCircuitOpenError(new Date(forbiddenUntil).toISOString());
};

export const recordOpenverseFailure = (
  details: OpenverseHttpFailureDetails | null,
  now = Date.now()
): void => {
  if (details?.status === 403) {
    forbiddenUntil = Math.max(forbiddenUntil, now + OPENVERSE_FORBIDDEN_COOLDOWN_MS);
  }
};

/**
 * A success may belong to a request that was already in flight when another
 * request received a provider-wide 403. Do not let that late success cancel
 * the cooldown; the next request is allowed to probe again after expiry.
 */
export const recordOpenverseSuccess = (now = Date.now()): void => {
  if (forbiddenUntil <= now) {
    forbiddenUntil = 0;
  }
};

/** Test-only reset hook; production callers should use success/failure events. */
export const resetOpenverseCircuitForTests = (): void => {
  forbiddenUntil = 0;
};
