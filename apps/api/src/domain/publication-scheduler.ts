import type { PublicationWorker, PublicationWorkerResult } from "./publication-worker.js";

type SchedulerTimer = ReturnType<typeof setTimeout>;

export type PublicationSchedulerOptions = {
  now?: () => Date;
  retryAfterErrorMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => SchedulerTimer;
  clearTimer?: (timer: SchedulerTimer) => void;
  onResults?: (results: PublicationWorkerResult[]) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

const DEFAULT_ERROR_RETRY_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export class PublicationScheduler {
  private started = false;
  private timer?: SchedulerTimer;
  private activeRun?: Promise<PublicationWorkerResult[]>;
  private triggerDrain?: Promise<PublicationWorkerResult[] | undefined>;
  private pending = false;
  private retryAfterRunError = false;
  private wakeLookup?: Promise<void>;
  private wakeRevision = 0;
  private readonly now: () => Date;
  private readonly retryAfterErrorMs: number;
  private readonly setTimer: NonNullable<PublicationSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<PublicationSchedulerOptions["clearTimer"]>;

  constructor(
    private readonly worker: PublicationWorker,
    private readonly options: PublicationSchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryAfterErrorMs = options.retryAfterErrorMs ?? DEFAULT_ERROR_RETRY_MS;
    if (!Number.isFinite(this.retryAfterErrorMs) || this.retryAfterErrorMs < 1_000) {
      throw new Error("Publication scheduler error retry interval must be at least one second.");
    }
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.pending = false;
    this.clearScheduledTimer();
    await this.triggerDrain;
    await this.activeRun;
  }

  // New publication jobs and explicit approvals call this method. Future jobs are
  // scheduled at their exact due time by nextWakeAt(), so an empty queue has no poll.
  async trigger(): Promise<PublicationWorkerResult[] | undefined> {
    if (!this.started) return undefined;
    this.wakeRevision += 1;
    this.pending = true;
    this.clearScheduledTimer();
    if (this.triggerDrain) return this.triggerDrain;

    this.triggerDrain = (async () => {
      let results: PublicationWorkerResult[] | undefined;
      while (this.started && this.pending) {
        if (this.activeRun) {
          await this.activeRun;
          if (!this.started) break;
        }
        if (!this.pending) continue;
        this.pending = false;
        results = await this.runNow(this.now());
      }
      return results;
    })().finally(() => {
      this.triggerDrain = undefined;
      if (this.started && this.pending) void this.trigger();
      else if (this.started) void this.scheduleNext();
    });
    return this.triggerDrain;
  }

  async runNow(now = this.now()): Promise<PublicationWorkerResult[]> {
    if (this.activeRun) return this.activeRun;
    this.wakeRevision += 1;
    const run = Promise.resolve()
      .then(() => this.worker.runOnce(now))
      .then(async (results) => {
        this.retryAfterRunError = false;
        if (results.length > 0) await this.notifyResults(results);
        return results;
      })
      .catch(async (error) => {
        this.retryAfterRunError = true;
        await this.notifyError(error);
        return [];
      })
      .finally(() => {
        this.activeRun = undefined;
        if (this.started && !this.triggerDrain && !this.pending) void this.scheduleNext();
      });
    this.activeRun = run;
    return run;
  }

  private async scheduleNext(): Promise<void> {
    if (!this.started || this.timer || this.activeRun || this.triggerDrain || this.pending || this.wakeLookup) return;
    if (this.retryAfterRunError) {
      this.retryAfterRunError = false;
      this.scheduleRetry();
      return;
    }
    const revision = this.wakeRevision;
    const lookup = (async () => {
      try {
        const nextWakeAt = await this.worker.nextWakeAt();
        if (revision !== this.wakeRevision || !this.started || this.timer || this.activeRun || this.triggerDrain || this.pending || !nextWakeAt) return;
        const nextTime = nextWakeAt.getTime();
        if (!Number.isFinite(nextTime)) return;
        const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextTime - this.now().getTime()));
        this.timer = this.setTimer(() => {
          this.timer = undefined;
          void this.trigger();
        }, delayMs);
        (this.timer as SchedulerTimer & { unref?: () => void }).unref?.();
      } catch (error) {
        if (revision !== this.wakeRevision || !this.started) return;
        await this.notifyError(error);
        this.scheduleRetry();
      }
    })();
    this.wakeLookup = lookup;
    try {
      await lookup;
    } finally {
      if (this.wakeLookup === lookup) this.wakeLookup = undefined;
      if (this.started && revision !== this.wakeRevision && !this.timer && !this.activeRun && !this.triggerDrain && !this.pending) {
        void this.scheduleNext();
      }
    }
  }

  private scheduleRetry(): void {
    if (!this.started || this.timer || this.triggerDrain || this.pending) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.trigger();
    }, this.retryAfterErrorMs);
    (this.timer as SchedulerTimer & { unref?: () => void }).unref?.();
  }

  private clearScheduledTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private async notifyResults(results: PublicationWorkerResult[]): Promise<void> {
    if (!this.options.onResults) return;
    try {
      await this.options.onResults(results);
    } catch (error) {
      await this.notifyError(error);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    if (!this.options.onError) return;
    try {
      await this.options.onError(error);
    } catch {
      // Observer failures must not change the worker's execution outcome.
    }
  }
}
