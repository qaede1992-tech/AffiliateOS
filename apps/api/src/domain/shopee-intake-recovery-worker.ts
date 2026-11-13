import type { ShopeeAffiliateLinkIntakeService, ShopeeIntakeRecoveryResult } from "./shopee-affiliate-link-intake.js";

export type ShopeeIntakeRecoveryWorkerOptions = {
  batchSize?: number;
  concurrency?: number;
  resolverTimeoutMs?: number;
};

export class ShopeeIntakeRecoveryWorker {
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly resolverTimeoutMs: number;

  constructor(
    private readonly service: Pick<ShopeeAffiliateLinkIntakeService, "recoverStaleResolvingBatch" | "nextStaleResolvingAt">,
    options: ShopeeIntakeRecoveryWorkerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.concurrency = options.concurrency ?? 3;
    this.resolverTimeoutMs = options.resolverTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) throw new Error("Shopee intake recovery batch size must be between 1 and 500.");
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 20) throw new Error("Shopee intake recovery concurrency must be between 1 and 20.");
    if (!Number.isInteger(this.resolverTimeoutMs) || this.resolverTimeoutMs < 1_000 || this.resolverTimeoutMs > 60_000) throw new Error("Shopee intake resolver timeout must be between 1000 and 60000 milliseconds.");
  }

  nextWakeAt(): Promise<Date | undefined> {
    return this.service.nextStaleResolvingAt();
  }

  runOnce(): Promise<ShopeeIntakeRecoveryResult> {
    return this.service.recoverStaleResolvingBatch({
      batchSize: this.batchSize,
      concurrency: this.concurrency,
      resolverTimeoutMs: this.resolverTimeoutMs
    });
  }
}
