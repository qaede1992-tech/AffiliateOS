import type { ProviderEventRecord, ProviderEventStore } from "../db/provider-events.js";
import type { ProviderEventConversionProcessor } from "./provider-event-conversion-processor.js";

export type ProviderEventWorkerResult = {
  scanned: number;
  processed: number;
  failed: number;
};

export class ProviderEventWorker {
  constructor(
    private readonly store: Pick<ProviderEventStore, "listProcessable">,
    private readonly processor: ProviderEventConversionProcessor,
    private readonly batchSize = 100
  ) {}

  async runOnce(): Promise<ProviderEventWorkerResult> {
    const events = await this.store.listProcessable(this.batchSize);
    let processed = 0;
    let failed = 0;
    for (const event of events as ProviderEventRecord[]) {
      try {
        const result = await this.processor.process(event.affiliateAccountId, event.externalEventId);
        if (result.processed) processed += 1;
      } catch {
        failed += 1;
      }
    }
    return { scanned: events.length, processed, failed };
  }
}
