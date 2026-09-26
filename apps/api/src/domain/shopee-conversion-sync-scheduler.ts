import type { MarketplaceConnectionView } from "@affiliateos/shared";
import type { AutonomousCycleLock } from "./autonomous-cycle-lock.js";
import type { MarketplaceService } from "./marketplace.js";
import type { MarketplaceConversionSyncResult, ShopeeConversionSyncService } from "./shopee-conversion-sync.js";

export type ShopeeConversionSyncSchedulerOptions = {
  intervalMs?: number;
  lookbackHours?: number;
  now?: () => Date;
  onResult?: (result: ShopeeConversionSyncSchedulerResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

export type ShopeeConversionSyncSchedulerResult = {
  attemptedConnections: number;
  locked: boolean;
  fetched: number;
  created: number;
  alreadyProcessed: number;
  skippedUnattributed: number;
  failed: number;
  connectionResults: Array<{
    connectionSlug: string;
    result: MarketplaceConversionSyncResult;
  }>;
};

export type ShopeeConversionSyncSchedulerStatus = {
  running: boolean;
  active: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: ShopeeConversionSyncSchedulerResult;
  lastError?: string;
};

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOOKBACK_HOURS = 8 * 24;
const MAX_LOOKBACK_HOURS = 31 * 24;
const LOCK_KEY = "affiliateos:shopee-conversion-sync";
type TimerHandle = ReturnType<typeof setTimeout>;

export class ShopeeConversionSyncScheduler {
  private readonly intervalMs: number;
  private readonly lookbackHours: number;
  private readonly now: () => Date;
  private readonly onResult?: ShopeeConversionSyncSchedulerOptions["onResult"];
  private readonly onError?: ShopeeConversionSyncSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ShopeeConversionSyncSchedulerResult>;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: ShopeeConversionSyncSchedulerResult;
  private lastError?: string;

  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly syncService: ShopeeConversionSyncService,
    private readonly lock: AutonomousCycleLock,
    options: ShopeeConversionSyncSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Shopee conversion sync scheduler interval must be at least 5 minutes.");
    }
    this.lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    if (!Number.isFinite(this.lookbackHours) || this.lookbackHours <= 0 || this.lookbackHours > MAX_LOOKBACK_HOURS) {
      throw new Error("Shopee conversion sync lookback must be greater than 0 and no more than 31 days.");
    }
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get status(): ShopeeConversionSyncSchedulerStatus {
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

  async runNow(): Promise<ShopeeConversionSyncSchedulerResult> {
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

  private async execute(): Promise<ShopeeConversionSyncSchedulerResult> {
    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    const empty = {
      attemptedConnections: 0,
      locked: acquired,
      fetched: 0,
      created: 0,
      alreadyProcessed: 0,
      skippedUnattributed: 0,
      failed: 0,
      connectionResults: []
    } satisfies ShopeeConversionSyncSchedulerResult;
    if (!acquired) return empty;

    try {
      const connections = (await this.marketplace.listConnections())
        .filter((connection: MarketplaceConnectionView) =>
          connection.providerSlug === "shopee-affiliate" &&
          connection.enabled &&
          connection.status === "active"
        );
      const since = new Date(this.now().getTime() - this.lookbackHours * 60 * 60_000).toISOString();
      const result: ShopeeConversionSyncSchedulerResult = {
        ...empty,
        attemptedConnections: connections.length,
        locked: true,
        connectionResults: []
      };

      for (const connection of connections) {
        try {
          const sync = await this.syncService.sync(connection.slug, since);
          result.connectionResults.push({ connectionSlug: connection.slug, result: sync });
          result.fetched += sync.fetched;
          result.created += sync.created;
          result.alreadyProcessed += sync.alreadyProcessed;
          result.skippedUnattributed += sync.skippedUnattributed;
          result.failed += sync.failed;
        } catch (error) {
          result.failed += 1;
          await this.notifyError(error);
        }
      }

      return result;
    } finally {
      await this.lock.release(LOCK_KEY);
    }
  }

  private async notifyResult(result: ShopeeConversionSyncSchedulerResult): Promise<void> {
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
      // Observer failures must not change scheduler execution semantics.
    }
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      // A failed cycle must not disable future scheduled recovery.
    }
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, this.intervalMs);
  }
}
