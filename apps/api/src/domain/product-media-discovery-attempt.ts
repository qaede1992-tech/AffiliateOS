export type ProductMediaDiscoveryOutcome = "success" | "no_results" | "provider_error";

export interface ProductMediaDiscoveryAttemptRepository {
  claim(input: { productId: string; fingerprint: string; now: string; leaseUntil: string }): Promise<boolean>;
  complete(input: { productId: string; fingerprint: string; outcome: ProductMediaDiscoveryOutcome; now: string; nextRetryAt: string }): Promise<void>;
}
