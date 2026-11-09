import type { ShopeeIntakeRecoveryWorker } from "./shopee-intake-recovery-worker.js";
import type { ShopeeIntakeRecoveryResult } from "./shopee-affiliate-link-intake.js";

export type ShopeeIntakeRecoverySchedulerOptions = {
  intervalMs?: number;
  idleMaxIntervalMs?: number;
  onResult?: (result: ShopeeIntakeRecoveryResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

type TimerHandle = ReturnType<typeof setTimeout>;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_MAX_INTERVAL_MS = 15 * 60_000;

export class ShopeeIntakeRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly idleMaxIntervalMs: number;
  private currentIntervalMs: number;
  private consecutiveEmptyRuns = 0;
  private readonly onResult?: ShopeeIntakeRecoverySchedulerOptions["onResult"];
  private readonly onError?: ShopeeIntakeRecoverySchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ShopeeIntakeRecoveryResult>;
  private started = false;

  constructor(
    private readonly worker: Pick<ShopeeIntakeRecoveryWorker, "runOnce">,
    options: ShopeeIntakeRecoverySchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.idleMaxIntervalMs = options.idleMaxIntervalMs ?? DEFAULT_IDLE_MAX_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 10_000) throw new Error("Shopee intake recovery interval must be at least 10 seconds.");
    if (!Number.isFinite(this.idleMaxIntervalMs) || this.idleMaxIntervalMs < this.intervalMs || this.idleMaxIntervalMs > 3_600_000) {
      throw new Error("Shopee intake recovery idle maximum must be between the base interval and one hour.");
    }
    this.currentIntervalMs = this.intervalMs;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  /** Current delay before the next scheduled poll; exposed for health diagnostics. */
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
    // A failed worker has already been reported through onError. Do not let
    // that failure abort application shutdown before the database is closed.
    await this.activeRun?.catch(() => undefined);
  }

  async runNow(): Promise<ShopeeIntakeRecoveryResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.worker.runOnce()
      .then(async (result) => {
        this.updateIntervalAfterResult(result);
        try { await this.onResult?.(result); } catch (error) { await this.notifyError(error); }
        return result;
      })
      .catch(async (error) => {
        // Retry failures at the normal cadence; idle backoff is only for a
        // confirmed empty queue, never for database/provider errors.
        this.resetInterval();
        await this.notifyError(error);
        throw error;
      })
      .finally(() => { this.activeRun = undefined; });
    return this.activeRun;
  }

  private updateIntervalAfterResult(result: ShopeeIntakeRecoveryResult): void {
    if (result.scanned > 0) {
      this.resetInterval();
      return;
    }
    // Keep the first empty poll at the normal cadence. Increase subsequent
    // empty polls exponentially, capped at 15 minutes by default.
    if (this.consecutiveEmptyRuns > 0) {
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.idleMaxIntervalMs);
    }
    this.consecutiveEmptyRuns += 1;
  }

  private resetInterval(): void {
    this.consecutiveEmptyRuns = 0;
    this.currentIntervalMs = this.intervalMs;
  }

  private async notifyError(error: unknown): Promise<void> {
    try { await this.onError?.(error); } catch { /* Observer failures do not change worker semantics. */ }
  }

  private async runAndSchedule(): Promise<void> {
    try { await this.runNow(); } catch { /* Continue on the next scheduled cycle. */ }
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, this.currentIntervalMs);
  }
}
