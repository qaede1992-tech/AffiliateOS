import type { PublicationWorker, PublicationWorkerResult } from "./publication-worker.js";

export type PublicationSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
  onResults?: (results: PublicationWorkerResult[]) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

const DEFAULT_INTERVAL_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export class PublicationScheduler {
  private readonly intervalMs: number;
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
    this.now = options.now ?? (() => new Date());
    this.onResults = options.onResults;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
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
        if (results.length > 0) await this.notifyResults(results);
      })
      .catch(async (error) => {
        await this.notifyError(error);
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    return this.activeRun;
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
    }, this.intervalMs);
  }
}
