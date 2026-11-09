import type { PublicationWorker, PublicationWorkerResult } from "./publication-worker.js";

export type PublicationSchedulerOptions = {
  intervalMs?: number;
  idleMaxIntervalMs?: number;
  now?: () => Date;
  onResults?: (results: PublicationWorkerResult[]) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_MAX_INTERVAL_MS = 2 * 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export class PublicationScheduler {
  private readonly intervalMs: number;
  private readonly idleMaxIntervalMs: number;
  private currentIntervalMs: number;
  private consecutiveEmptyRuns = 0;
  private readonly now: () => Date;
  private readonly onResults?: PublicationSchedulerOptions["onResults"];
  private readonly onError?: PublicationSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<void>;
  private started = false;

  constructor(private readonly worker: PublicationWorker, options: PublicationSchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("Publication scheduler interval must be a positive finite number.");
    }
    this.idleMaxIntervalMs = options.idleMaxIntervalMs ?? Math.max(this.intervalMs, DEFAULT_IDLE_MAX_INTERVAL_MS);
    if (!Number.isFinite(this.idleMaxIntervalMs) || this.idleMaxIntervalMs < this.intervalMs || this.idleMaxIntervalMs > 60 * 60_000) {
      throw new Error("Publication scheduler idle maximum must be between the base interval and one hour.");
    }
    this.currentIntervalMs = this.intervalMs;
    this.now = options.now ?? (() => new Date());
    this.onResults = options.onResults;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Current delay before the next poll; exposed for health diagnostics and deterministic tests. */
  get nextIntervalMs(): number {
    return this.currentIntervalMs;
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

  async runNow(now = this.now()): Promise<void> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.worker.runOnce(now)
      .then(async (results) => {
        this.updateIntervalAfterResults(results);
        if (results.length > 0) await this.notifyResults(results);
      })
      .catch(async (error) => {
        this.resetInterval();
        await this.notifyError(error);
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    return this.activeRun;
  }

  private updateIntervalAfterResults(results: PublicationWorkerResult[]): void {
    if (results.length > 0) {
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

  private async notifyResults(results: PublicationWorkerResult[]): Promise<void> {
    if (!this.onResults) return;
    try {
      await this.onResults(results);
    } catch (error) {
      await this.notifyError(error);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    if (!this.onError) return;
    try {
      await this.onError(error);
    } catch {
      // Observer failures must not escape the scheduler lifecycle.
    }
  }

  private async runAndSchedule(): Promise<void> {
    await this.runNow();
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, this.currentIntervalMs);
  }
}
