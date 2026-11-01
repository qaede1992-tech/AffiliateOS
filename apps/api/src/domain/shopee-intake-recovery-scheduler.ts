import type { ShopeeIntakeRecoveryWorker } from "./shopee-intake-recovery-worker.js";
import type { ShopeeIntakeRecoveryResult } from "./shopee-affiliate-link-intake.js";

export type ShopeeIntakeRecoverySchedulerOptions = {
  intervalMs?: number;
  onResult?: (result: ShopeeIntakeRecoveryResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export class ShopeeIntakeRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly onResult?: ShopeeIntakeRecoverySchedulerOptions["onResult"];
  private readonly onError?: ShopeeIntakeRecoverySchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ShopeeIntakeRecoveryResult>;
  private started = false;

  constructor(
    private readonly worker: Pick<ShopeeIntakeRecoveryWorker, "runOnce">,
    options: ShopeeIntakeRecoverySchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 10_000) throw new Error("Shopee intake recovery interval must be at least 10 seconds.");
    this.onResult = options.onResult;
    this.onError = options.onError;
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

  async runNow(): Promise<ShopeeIntakeRecoveryResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.worker.runOnce()
      .then(async (result) => {
        try { await this.onResult?.(result); } catch (error) { await this.notifyError(error); }
        return result;
      })
      .catch(async (error) => {
        await this.notifyError(error);
        throw error;
      })
      .finally(() => { this.activeRun = undefined; });
    return this.activeRun;
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
    }, this.intervalMs);
  }
}
