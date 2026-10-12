import type { ImportShopeeAffiliateFeedRequest, ImportShopeeAffiliateFeedResult } from "@affiliateos/shared";
import type { AutonomousCycleLock } from "./autonomous-cycle-lock.js";
import type { MarketplaceService } from "./marketplace.js";

export interface ShopeeAffiliateFeedSource {
  fetch(): Promise<ImportShopeeAffiliateFeedRequest>;
}

export type ShopeeAffiliateFeedIngestionSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
  onResult?: (result: ShopeeAffiliateFeedIngestionSchedulerResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

export type ShopeeAffiliateFeedIngestionSchedulerResult = {
  imported: boolean;
  result?: ImportShopeeAffiliateFeedResult;
};

export type ShopeeAffiliateFeedIngestionSchedulerStatus = {
  running: boolean;
  active: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: ShopeeAffiliateFeedIngestionSchedulerResult;
  lastError?: string;
};

const DEFAULT_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const LOCK_KEY = "affiliateos:shopee-affiliate-feed-ingestion";
type TimerHandle = ReturnType<typeof setTimeout>;

export class ShopeeAffiliateFeedIngestionScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: ShopeeAffiliateFeedIngestionSchedulerOptions["onResult"];
  private readonly onError?: ShopeeAffiliateFeedIngestionSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ShopeeAffiliateFeedIngestionSchedulerResult>;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: ShopeeAffiliateFeedIngestionSchedulerResult;
  private lastError?: string;

  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly source: ShopeeAffiliateFeedSource,
    private readonly lock: AutonomousCycleLock,
    options: ShopeeAffiliateFeedIngestionSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Shopee affiliate feed ingestion interval must be at least 15 minutes.");
    }
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get status(): ShopeeAffiliateFeedIngestionSchedulerStatus {
    return {
      running: this.started,
      active: Boolean(this.activeRun),
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runAndSchedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  async runNow(): Promise<ShopeeAffiliateFeedIngestionSchedulerResult> {
    if (this.activeRun) return this.activeRun;

    this.lastStartedAt = this.now().toISOString();
    this.lastError = undefined;
    this.activeRun = this.execute()
      .then(async (result) => {
        this.lastResult = result;
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyResult(result);
        return result;
      })
      .catch(async (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyError(error);
        throw error;
      })
      .finally(() => {
        this.activeRun = undefined;
      });

    return this.activeRun;
  }

  private async execute(): Promise<ShopeeAffiliateFeedIngestionSchedulerResult> {
    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) return { imported: false };

    try {
      const input = await this.source.fetch();
      const result = await this.marketplace.importShopeeAffiliateFeed(input);
      return { imported: true, result };
    } finally {
      await this.lock.release(LOCK_KEY);
    }
  }

  private async notifyResult(result: ShopeeAffiliateFeedIngestionSchedulerResult): Promise<void> {
    if (!this.onResult) return;
    try {
      await this.onResult(result);
    } catch (error) {
      await this.notifyError(error);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    if (!this.onError) return;
    try {
      await this.onError(error);
    } catch {
      // Observer failures must not change ingestion semantics.
    }
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      // A failed ingestion must not disable future scheduled attempts.
    }
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, this.intervalMs);
  }
}
