import { and, eq } from "drizzle-orm";
import { providerEvents } from "./schema.js";

type DatabaseExecutor = any;

export type ProviderEventRecord = {
  id: string;
  affiliateAccountId: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureVersion?: string;
  status?: string;
  receivedAt: string;
};

export class ProviderEventStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async insertIfNew(event: ProviderEventRecord): Promise<boolean> {
    const result = await this.db.insert(providerEvents).values({
      id: event.id,
      affiliateAccountId: event.affiliateAccountId,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      payload: event.payload,
      signatureVersion: event.signatureVersion ?? null,
      status: event.status ?? "received",
      receivedAt: event.receivedAt,
      processedAt: null,
      error: null,
    }).onConflictDoNothing({
      target: [providerEvents.affiliateAccountId, providerEvents.externalEventId],
    });

    return Number(result.rowCount ?? 0) === 1;
  }

  async findByExternalId(affiliateAccountId: string, externalEventId: string) {
    const rows = await this.db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId)))
      .limit(1);
    return rows[0];
  }
}
