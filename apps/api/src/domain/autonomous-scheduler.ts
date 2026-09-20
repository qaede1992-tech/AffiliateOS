import type { AutonomousCycleInput, AutonomousCycleResult, AutonomousCycleService } from "./autonomous-cycle.js";

export type AutonomousSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
  onResult?: (result: AutonomousCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

const DEFAULT_INTERVAL_MS = 15 * 60_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export class AutonomousScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: AutonomousSchedulerOptions["onResult"];
  private readonly onError?: AutonomousSchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<AutonomousCycleResult | undefined>;
  private started = false;

  constructor(
    private readonly cycle: AutonomousCycleService,
    private readonly input: AutonomousCycleInput = {},
    options: AutonomousSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("Autonomous scheduler interval must be a positive finite number.");
    }
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
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

  async runNow(input: AutonomousCycleInput = this.input): Promise<AutonomousCycleResult | undefined> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.cycle.runOnce(input)
      .then(async (result) => {
        if (result && this.onResult) await this.onResult(result);
        return result;
      })
      .catch(async (error) => {
        if (this.onError) await this.onError(error);
        return undefined;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    return this.activeRun;
  }

  private async runAndSchedule(): Promise<void> {
    await this.runNow({ ...this.input, idempotencyNamespace: this.input.idempotencyNamespace ?? this.cycleNamespace() });
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
