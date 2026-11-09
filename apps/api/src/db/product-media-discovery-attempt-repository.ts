import { and, eq, lt, ne, or } from "drizzle-orm";
import type { ProductMediaDiscoveryAttemptRepository, ProductMediaDiscoveryOutcome } from "../domain/product-media-discovery-attempt.js";
import { productMediaDiscoveryAttempts } from "./schema.js";

type DatabaseExecutor = any;

/**
 * One compact row per product. A conditional upsert is the cross-process lease:
 * only a changed identity or an expired lease/cooldown can start another search.
 */
export class DrizzleProductMediaDiscoveryAttemptRepository implements ProductMediaDiscoveryAttemptRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async claim(input: { productId: string; fingerprint: string; now: string; leaseUntil: string }): Promise<boolean> {
    const rows = await this.db.insert(productMediaDiscoveryAttempts).values({
      productId: input.productId,
      fingerprint: input.fingerprint,
      status: "in_progress",
      nextRetryAt: input.leaseUntil,
      updatedAt: input.now
    }).onConflictDoUpdate({
      target: productMediaDiscoveryAttempts.productId,
      set: {
        fingerprint: input.fingerprint,
        status: "in_progress",
        nextRetryAt: input.leaseUntil,
        updatedAt: input.now
      },
      setWhere: or(
        ne(productMediaDiscoveryAttempts.fingerprint, input.fingerprint),
        lt(productMediaDiscoveryAttempts.nextRetryAt, input.now)
      )
    }).returning({ productId: productMediaDiscoveryAttempts.productId });
    return rows.length > 0;
  }

  async complete(input: { productId: string; fingerprint: string; leaseUntil: string; outcome: ProductMediaDiscoveryOutcome; now: string; nextRetryAt: string }): Promise<void> {
    await this.db.update(productMediaDiscoveryAttempts).set({
      status: input.outcome,
      nextRetryAt: input.nextRetryAt,
      updatedAt: input.now
    }).where(and(
      eq(productMediaDiscoveryAttempts.productId, input.productId),
      eq(productMediaDiscoveryAttempts.fingerprint, input.fingerprint),
      eq(productMediaDiscoveryAttempts.status, "in_progress"),
      eq(productMediaDiscoveryAttempts.nextRetryAt, input.leaseUntil)
    ));
  }
}
