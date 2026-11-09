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
  pending: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: AutonomousCycleResult;
  lastError?: string;
  lastSkipReason?: "already_running" | "lock_busy" | "no_candidates";
};

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;

export class AutonomousScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: AutonomousSchedulerOptions["onResult"];
  private readonly onError?: AutonomousSchedulerOptions["onError"];
  private activeRun?: Promise<AutonomousCycleResult | undefined>;
  private triggerDrain?: Promise<AutonomousCycleResult | undefined>;
  private triggerRequested = false;
  private started = false;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: AutonomousCycleResult;
  private lastError?: string;
  private lastSkipReason?: "already_running" | "lock_busy" | "no_candidates";

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
      pending: this.triggerRequested,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastSkipReason: this.lastSkipReason
    };
  }

  // Starting the scheduler only enables event handling. It deliberately performs
  // no startup scan and creates no recurring timer.
  start(): void {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.triggerRequested = false;
    await this.triggerDrain;
    await this.activeRun;
  }

  async previewSelection(input: AutonomousCycleInput = this.input) {
    return this.cycle.previewSelection(input);
  }

  // Called only after a product/offer import or another durable source event.
  // Multiple events arriving during a run are coalesced into one follow-up run.
  async trigger(input: AutonomousCycleInput = this.input): Promise<AutonomousCycleResult | undefined> {
    if (!this.started) return undefined;
    this.triggerRequested = true;
    if (this.triggerDrain) return this.triggerDrain;

    this.triggerDrain = (async () => {
      let result: AutonomousCycleResult | undefined;
      while (this.started && this.triggerRequested) {
        this.triggerRequested = false;
        result = await this.runNow(input);
      }
      return result;
    })().finally(() => {
      this.triggerDrain = undefined;
    });
    return this.triggerDrain;
  }

  async runNow(input: AutonomousCycleInput = this.input): Promise<AutonomousCycleResult | undefined> {
    if (this.activeRun) return this.activeRun;
    const effectiveInput: AutonomousCycleInput = {
      ...input,
      idempotencyNamespace: input.idempotencyNamespace ?? this.cycleNamespace()
    };
    this.lastStartedAt = this.now().toISOString();
    this.lastError = undefined;
    this.lastSkipReason = undefined;
    const run = this.cycle.runOnce(effectiveInput)
      .then(async (result) => {
        this.lastSkipReason = this.cycle.skipReason;
        if (result) {
          this.lastResult = result;
          await this.notifyResult(result);
        }
        this.lastCompletedAt = this.now().toISOString();
        return result;
      })
      .catch(async (error) => {
        this.lastSkipReason = undefined;
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
      await this.notifyError(error);
    }
  }

  private async notifyError(error: unknown): Promise<void> {
    if (!this.onError) return;
    try {
      await this.onError(error);
    } catch {
      // Observer failures must not change the scheduler's execution outcome.
    }
  }

  private cycleNamespace(): string {
    const bucket = Math.floor(this.now().getTime() / this.intervalMs);
    return `autonomous-cycle:${bucket}`;
  }
}
