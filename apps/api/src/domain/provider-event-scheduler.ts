import type { ProviderEventWorker, ProviderEventWorkerResult } from "./provider-event-worker.js";

export type ProviderEventSchedulerOptions = {
  intervalMs?: number;
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
const MIN_INTERVAL_MS = 10_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export class ProviderEventScheduler {
  private readonly intervalMs: number;
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
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
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
    }, this.intervalMs);
  }
}
