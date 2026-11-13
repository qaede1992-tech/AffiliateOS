import type { ShopeeIntakeRecoveryWorker } from "./shopee-intake-recovery-worker.js";
import type { ShopeeIntakeRecoveryResult } from "./shopee-affiliate-link-intake.js";

export type ShopeeIntakeRecoverySchedulerOptions = {
  /** Retry delay after a database/worker error. Idle queues are event-driven and never polled. */
  intervalMs?: number;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onResult?: (result: ShopeeIntakeRecoveryResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

type TimerHandle = ReturnType<typeof setTimeout>;
const DEFAULT_RETRY_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export class ShopeeIntakeRecoveryScheduler {
  private readonly retryIntervalMs: number;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<ShopeeIntakeRecoverySchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ShopeeIntakeRecoverySchedulerOptions["clearTimer"]>;
  private readonly onResult?: ShopeeIntakeRecoverySchedulerOptions["onResult"];
  private readonly onError?: ShopeeIntakeRecoverySchedulerOptions["onError"];
  private timer?: TimerHandle;
  private activeRun?: Promise<ShopeeIntakeRecoveryResult>;
  private wakeLookup?: Promise<void>;
  private wakeRevision = 0;
  private retryAfterError = false;
  private started = false;

  constructor(
    private readonly worker: Pick<ShopeeIntakeRecoveryWorker, "runOnce" | "nextWakeAt">,
    options: ShopeeIntakeRecoverySchedulerOptions = {}
  ) {
    this.retryIntervalMs = options.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    if (!Number.isFinite(this.retryIntervalMs) || this.retryIntervalMs < 1_000 || this.retryIntervalMs > 3_600_000) {
      throw new Error("Shopee intake recovery retry interval must be between one second and one hour.");
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

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.scheduleNext();
  }

  /**
   * Called when an intake enters or leaves the resolving state. It only refreshes
   * the bounded wake-time lookup; it never starts a recovery worker by itself.
   */
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
    // A failed worker has already been reported through onError. Do not let
    // that failure abort application shutdown before the database is closed.
    await this.activeRun?.catch(() => undefined);
  }

  async runNow(): Promise<ShopeeIntakeRecoveryResult> {
    if (this.activeRun) return this.activeRun;
    this.wakeRevision += 1;
    this.activeRun = Promise.resolve()
      .then(() => this.worker.runOnce())
      .then(async (result) => {
        this.retryAfterError = false;
        try { await this.onResult?.(result); } catch (error) { await this.notifyError(error); }
        return result;
      })
      .catch(async (error) => {
        this.retryAfterError = true;
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
        if (!Number.isFinite(nextTime)) throw new Error("Shopee intake recovery returned an invalid wake time.");
        const now = this.now().getTime();
        if (nextTime <= now) {
          // A zero-result run with an already-due row can be a concurrent CAS race.
          // Back off briefly instead of spinning on the same stale candidate.
          this.scheduleRetry();
          return;
        }
        const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextTime - now));
        this.timer = this.setTimer(() => {
          this.timer = undefined;
          void this.runDue();
        }, delayMs);
        (this.timer as TimerHandle & { unref?: () => void }).unref?.();
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
      if (this.started && revision !== this.wakeRevision && !this.timer && !this.activeRun) {
        void this.scheduleNext();
      }
    }
  }

  private async runDue(): Promise<void> {
    if (!this.started) return;
    try { await this.runNow(); } catch { /* A retry timer is scheduled by runNow(). */ }
  }

  private scheduleRetry(): void {
    if (!this.started || this.timer || this.activeRun) return;
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

  private async notifyError(error: unknown): Promise<void> {
    try { await this.onError?.(error); } catch { /* Observer failures do not change worker semantics. */ }
  }
}
