import type { ProviderEventWorker, ProviderEventWorkerResult } from "./provider-event-worker.js";

export type ProviderEventSchedulerOptions = {
  /** Delay used only to retry a failed worker or wake-time lookup; idle queues are not polled. */
  intervalMs?: number;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
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

const DEFAULT_RETRY_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

const safeErrorType = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";

type TimerHandle = ReturnType<typeof setTimeout>;

export class ProviderEventScheduler {
  private readonly retryIntervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: ProviderEventSchedulerOptions["onResult"];
  private readonly onError?: ProviderEventSchedulerOptions["onError"];
  private readonly setTimer: NonNullable<ProviderEventSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ProviderEventSchedulerOptions["clearTimer"]>;
  private timer?: TimerHandle;
  private activeRun?: Promise<ProviderEventWorkerResult>;
  private wakeLookup?: Promise<void>;
  private wakeRevision = 0;
  private retryAfterError = false;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: ProviderEventWorkerResult;
  private lastError?: string;

  constructor(
    private readonly worker: Pick<ProviderEventWorker, "runOnce" | "nextWakeAt">,
    options: ProviderEventSchedulerOptions = {}
  ) {
    this.retryIntervalMs = options.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    if (!Number.isFinite(this.retryIntervalMs) || this.retryIntervalMs < MIN_INTERVAL_MS) {
      throw new Error("Provider event scheduler retry interval must be at least 10 seconds.");
    }
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Retained for diagnostics; this is the error retry delay, not an idle poll interval. */
  get nextIntervalMs(): number {
    return this.retryIntervalMs;
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
    void this.scheduleNext();
  }

  /** Wake after a provider event is persisted; an empty queue remains completely idle. */
  notifyChanged(): void {
    if (!this.started) return;
    this.wakeRevision += 1;
    this.retryAfterError = false;
    this.clearScheduledTimer();
    void this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.wakeRevision += 1;
    this.clearScheduledTimer();
    await this.activeRun?.catch(() => undefined);
  }

  async runNow(): Promise<ProviderEventWorkerResult> {
    if (this.activeRun) return this.activeRun;

    this.wakeRevision += 1;
    this.lastStartedAt = this.now().toISOString();
    this.lastError = undefined;
    this.activeRun = Promise.resolve()
      .then(() => this.worker.runOnce())
      .then(async (result) => {
        this.lastResult = result;
        this.retryAfterError = false;
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyResult(result);
        return result;
      })
      .catch(async (error) => {
        this.retryAfterError = true;
        this.lastError = safeErrorType(error);
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyError(error);
        throw error;
      })
      .finally(() => {
        this.activeRun = undefined;
        if (this.started) void this.scheduleNext();
      });

    return this.activeRun;
  }

  private async scheduleNext(): Promise<void> {
    if (!this.started || this.timer || this.activeRun || this.wakeLookup) return;
    if (this.retryAfterError) {
      this.scheduleRetry();
      return;
    }

    const revision = this.wakeRevision;
    const lookup = (async () => {
      try {
        const nextWakeAt = await this.worker.nextWakeAt();
        if (revision !== this.wakeRevision || !this.started || this.timer || this.activeRun || !nextWakeAt) return;
        const nextTime = nextWakeAt.getTime();
        if (!Number.isFinite(nextTime)) throw new Error("Provider event store returned an invalid wake time.");
        const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextTime - this.now().getTime()));
        this.timer = this.setTimer(() => {
          this.timer = undefined;
          void this.runDue();
        }, delayMs);
        (this.timer as TimerHandle & { unref?: () => void }).unref?.();
      } catch (error) {
        if (revision !== this.wakeRevision || !this.started) return;
        this.retryAfterError = true;
        this.lastError = safeErrorType(error);
        await this.notifyError(error);
      }
    })();

    this.wakeLookup = lookup;
    try {
      await lookup;
    } finally {
      if (this.wakeLookup === lookup) this.wakeLookup = undefined;
      if (this.started && !this.timer && !this.activeRun && (revision !== this.wakeRevision || this.retryAfterError)) {
        void this.scheduleNext();
      }
    }
  }

  private async runDue(): Promise<void> {
    if (!this.started) return;
    try {
      await this.runNow();
    } catch {
      // runNow schedules a bounded retry after a worker failure.
    }
  }

  private scheduleRetry(): void {
    if (!this.started || this.timer || this.activeRun || this.wakeLookup) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.runDue();
    }, this.retryIntervalMs);
    (this.timer as TimerHandle & { unref?: () => void }).unref?.();
  }

  private clearScheduledTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
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
}
