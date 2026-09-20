import { and, eq, or } from "drizzle-orm";
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

export type ProviderEventStatus = "received" | "processing" | "processed" | "failed";

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
    }).onConflictDoNothing({ target: [providerEvents.affiliateAccountId, providerEvents.externalEventId] });
    return Number(result.rowCount ?? 0) === 1;
  }

  async findByExternalId(affiliateAccountId: string, externalEventId: string) {
    const rows = await this.db.select().from(providerEvents)
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId))).limit(1);
    return rows[0];
  }

  async claimForProcessing(affiliateAccountId: string, externalEventId: string): Promise<boolean> {
    const result = await this.db.update(providerEvents)
      .set({ status: "processing", error: null })
      .where(and(
        eq(providerEvents.affiliateAccountId, affiliateAccountId),
        eq(providerEvents.externalEventId, externalEventId),
        or(eq(providerEvents.status, "received"), eq(providerEvents.status, "failed"))
      ));
    return Number(result.rowCount ?? 0) === 1;
  }

  async updateStatus(affiliateAccountId: string, externalEventId: string, status: ProviderEventStatus, error?: string): Promise<boolean> {
    const values: Record<string, unknown> = { status, error: error?.slice(0, 1000) ?? null };
    if (status === "processed") values.processedAt = new Date().toISOString();
    const result = await this.db.update(providerEvents).set(values)
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId)));
    return Number(result.rowCount ?? 0) === 1;
  }
}
