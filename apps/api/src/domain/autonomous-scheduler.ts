import type { AutonomousCycleInput, AutonomousCycleResult, AutonomousCycleService } from "./autonomous-cycle.js";

export type AutonomousSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
  onResult?: (result: AutonomousCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

export type AutonomousSchedulerStatus = {
  running: boolean;
  active: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: AutonomousCycleResult;
  lastError?: string;
};

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export class AutonomousScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: AutonomousSchedulerOptions["onResult"];
  private readonly onError?: AutonomousSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<AutonomousCycleResult | undefined>;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: AutonomousCycleResult;
  private lastError?: string;

  constructor(
    private readonly cycle: AutonomousCycleService,
    private readonly input: AutonomousCycleInput = {},
    options: AutonomousSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Autonomous scheduler interval must be at least 5 minutes.");
    }
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get status(): AutonomousSchedulerStatus {
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

  async runNow(input: AutonomousCycleInput = this.input): Promise<AutonomousCycleResult | undefined> {
    if (this.activeRun) return this.activeRun;
    const effectiveInput: AutonomousCycleInput = {
      ...input,
      idempotencyNamespace: input.idempotencyNamespace ?? this.cycleNamespace()
    };
    this.lastStartedAt = this.now().toISOString();
    this.lastError = undefined;
    const run = this.cycle.runOnce(effectiveInput)
      .then(async (result) => {
        if (!result) return undefined;
        this.lastResult = result;
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyResult(result);
        return result;
      })
      .catch(async (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastCompletedAt = this.now().toISOString();
        await this.notifyError(error);
        return undefined;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = run;
    return run;
  }

  private async notifyResult(result: AutonomousCycleResult): Promise<void> {
    if (!this.onResult) return;
    try {
      await this.onResult(result);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.notifyError(error);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    if (!this.onError) return;
    try {
      await this.onError(error);
    } catch (callbackError) {
      this.lastError = callbackError instanceof Error ? callbackError.message : String(callbackError);
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

  private cycleNamespace(): string {
    const bucket = Math.floor(this.now().getTime() / this.intervalMs);
    return `autonomous-cycle:${bucket}`;
  }
}
