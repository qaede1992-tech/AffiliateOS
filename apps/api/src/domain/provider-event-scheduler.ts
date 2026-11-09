import type { ProviderEventWorker, ProviderEventWorkerResult } from "./provider-event-worker.js";

export type ProviderEventSchedulerOptions = {
  intervalMs?: number;
  idleMaxIntervalMs?: number;
  now?: () => Date;
  onResult?: (result: ProviderEventWorkerResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

export type ProviderEventSchedulerStatus = {
  running: boolean;
  active: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: ProviderEventWorkerResult;
  lastError?: string;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_MAX_INTERVAL_MS = 2 * 60_000;
const MIN_INTERVAL_MS = 10_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export class ProviderEventScheduler {
  private readonly intervalMs: number;
  private readonly idleMaxIntervalMs: number;
  private currentIntervalMs: number;
  private consecutiveEmptyRuns = 0;
  private readonly now: () => Date;
  private readonly onResult?: ProviderEventSchedulerOptions["onResult"];
  private readonly onError?: ProviderEventSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ProviderEventWorkerResult>;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: ProviderEventWorkerResult;
  private lastError?: string;

  constructor(
    private readonly worker: Pick<ProviderEventWorker, "runOnce">,
    options: ProviderEventSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Provider event scheduler interval must be at least 10 seconds.");
    }
    this.idleMaxIntervalMs = options.idleMaxIntervalMs ?? Math.max(this.intervalMs, DEFAULT_IDLE_MAX_INTERVAL_MS);
    if (!Number.isFinite(this.idleMaxIntervalMs) || this.idleMaxIntervalMs < this.intervalMs || this.idleMaxIntervalMs > 60 * 60_000) {
      throw new Error("Provider event scheduler idle maximum must be between the base interval and one hour.");
    }
    this.currentIntervalMs = this.intervalMs;
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Current delay before the next poll; exposed for health diagnostics and deterministic tests. */
  get nextIntervalMs(): number {
    return this.currentIntervalMs;
  }

  get status(): ProviderEventSchedulerStatus {
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

  async runNow(): Promise<ProviderEventWorkerResult> {
    if (this.activeRun) return this.activeRun;

    this.lastStartedAt = this.now().toISOString();
    this.lastError = undefined;
    this.activeRun = this.worker.runOnce()
      .then(async (result) => {
        this.lastResult = result;
        this.updateIntervalAfterResult(result);
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyResult(result);
        return result;
      })
      .catch(async (error) => {
        this.resetInterval();
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

  private updateIntervalAfterResult(result: ProviderEventWorkerResult): void {
    if (result.scanned > 0) {
      this.resetInterval();
      return;
    }
    if (this.consecutiveEmptyRuns > 0) {
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.idleMaxIntervalMs);
    }
    this.consecutiveEmptyRuns += 1;
  }

  private resetInterval(): void {
    this.consecutiveEmptyRuns = 0;
    this.currentIntervalMs = this.intervalMs;
  }

  private async notifyResult(result: ProviderEventWorkerResult): Promise<void> {
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
      // Observer failures must not alter worker execution semantics.
    }
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.runNow();
    } catch {
      // The next scheduled cycle is still allowed to recover after a worker-level failure.
    }
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, this.currentIntervalMs);
  }
}
