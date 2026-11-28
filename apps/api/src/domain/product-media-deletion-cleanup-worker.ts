import type { ProductMediaAsset } from "./product-media-ingestion.js";
import type { ProductMediaStorageClient } from "./supabase-storage.js";

export interface ProductMediaDeletionCleanupRepository {
  claimDeletionCleanupBatch(input: { limit: number; now: string; leaseUntil: string }): Promise<ProductMediaAsset[]>;
  completeDeletionCleanup(input: { assetId: string; leaseUntil: string; completedAt: string }): Promise<boolean>;
  failDeletionCleanup(input: { assetId: string; leaseUntil: string; failedAt: string; nextAttemptAt: string; errorType: string }): Promise<boolean>;
  nextDeletionCleanupAt(): Promise<string | undefined>;
}

export interface ProductMediaDeletionStorageAdapters {
  supabase?: ProductMediaStorageClient;
  localVolume?: ProductMediaStorageClient;
}

const safeErrorType = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";

/**
 * Bounded, lease-based cleanup. It performs no bucket scans or object downloads:
 * each retry removes only the exact object key persisted on the tombstoned row.
 * Scheduling is demand-driven; an idle queue leaves no recurring timer running.
 */
export class ProductMediaDeletionCleanupWorker {
  private running = false;
  private rerunRequested = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeRun?: Promise<void>;

  constructor(
    private readonly repository: ProductMediaDeletionCleanupRepository,
    private readonly storage: ProductMediaDeletionStorageAdapters,
    private readonly options: {
      batchSize?: number;
      leaseMs?: number;
      retryBaseMs?: number;
      retryMaxMs?: number;
      onError?: (error: unknown) => void;
    } = {}
  ) {}

  trigger(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.running) {
      this.rerunRequested = true;
      return this.activeRun ?? Promise.resolve();
    }
    const task = this.run();
    this.activeRun = task;
    void task.finally(() => {
      if (this.activeRun === task) this.activeRun = undefined;
    });
    return task;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.trigger();
    }, Math.max(1_000, delayMs));
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      const leaseMs = this.options.leaseMs ?? 180_000;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const assets = await this.repository.claimDeletionCleanupBatch({
        limit: this.options.batchSize ?? 5,
        now: now.toISOString(),
        leaseUntil
      });

      await Promise.all(assets.map(async (asset) => {
        try {
          const backend = asset.storageBackend ?? "supabase";
          const adapter = backend === "local_volume"
            ? this.storage.localVolume
            : backend === "supabase"
              ? this.storage.supabase
              : undefined;
          const expectedBucket = backend === "local_volume" ? "local-volume" : adapter?.bucketName;
          if (!adapter || !expectedBucket || adapter.bucketName !== asset.bucket || expectedBucket !== asset.bucket) {
            throw new Error("ProductMediaStorageBackendUnavailable");
          }

          await adapter.remove(asset.objectKey);
          await this.repository.completeDeletionCleanup({
            assetId: asset.id,
            leaseUntil,
            completedAt: new Date().toISOString()
          });
        } catch (error) {
          const attempts = Math.max(1, asset.storageCleanupAttempts ?? 1);
          const base = this.options.retryBaseMs ?? 30_000;
          const maximum = this.options.retryMaxMs ?? 3_600_000;
          const delay = Math.min(maximum, base * (2 ** Math.min(10, attempts - 1)));
          await this.repository.failDeletionCleanup({
            assetId: asset.id,
            leaseUntil,
            failedAt: new Date().toISOString(),
            nextAttemptAt: new Date(Date.now() + delay).toISOString(),
            errorType: safeErrorType(error)
          });
        }
      }));

      const nextAt = await this.repository.nextDeletionCleanupAt();
      if (nextAt) {
        const nextMs = Date.parse(nextAt);
        this.schedule(Number.isFinite(nextMs) ? Math.max(1_000, nextMs - Date.now()) : 60_000);
      }
    } catch (error) {
      this.options.onError?.(error);
      this.schedule(60_000);
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.trigger();
      }
    }
  }
}
