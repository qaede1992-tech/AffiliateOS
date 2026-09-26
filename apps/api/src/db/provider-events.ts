import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { providerEvents } from "./schema.js";

export const PROVIDER_EVENT_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
export const PROVIDER_EVENT_MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

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
      id: event.id, affiliateAccountId: event.affiliateAccountId, externalEventId: event.externalEventId,
      eventType: event.eventType, payload: event.payload, signatureVersion: event.signatureVersion ?? null,
      status: event.status ?? "received", receivedAt: event.receivedAt, processedAt: null,
      processingStartedAt: null, error: null,
    }).onConflictDoNothing({ target: [providerEvents.affiliateAccountId, providerEvents.externalEventId] });
    return Number(result.rowCount ?? 0) === 1;
  }

  async findByExternalId(affiliateAccountId: string, externalEventId: string) {
    const rows = await this.db.select().from(providerEvents)
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId))).limit(1);
    return rows[0];
  }

  async listProcessable(limit = 100): Promise<ProviderEventRecord[]> {
    const rows = await this.db.select().from(providerEvents)
      .where(or(
        eq(providerEvents.status, "received"),
        and(eq(providerEvents.status, "failed"), eq(providerEvents.retryCount, 0), eq(providerEvents.nextAttemptAt, null)),
        and(eq(providerEvents.status, "failed"), lte(providerEvents.nextAttemptAt, new Date().toISOString())),
        and(eq(providerEvents.status, "processing"),
          lte(providerEvents.processingStartedAt, new Date(Date.now() - PROVIDER_EVENT_PROCESSING_TIMEOUT_MS).toISOString()))
      ))
      .orderBy(asc(providerEvents.receivedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((row: typeof providerEvents.$inferSelect) => ({
      id: row.id, affiliateAccountId: row.affiliateAccountId, externalEventId: row.externalEventId,
      eventType: row.eventType, payload: row.payload as Record<string, unknown>,
      signatureVersion: row.signatureVersion ?? undefined, status: row.status ?? undefined, receivedAt: row.receivedAt
    }));
  }

  async claimForProcessing(affiliateAccountId: string, externalEventId: string): Promise<boolean> {
    const result = await this.db.update(providerEvents)
      .set({ status: "processing", processingStartedAt: new Date().toISOString(), error: null })
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId),
        or(eq(providerEvents.status, "received"),
          and(eq(providerEvents.status, "failed"), or(eq(providerEvents.retryCount, 0), lte(providerEvents.nextAttemptAt, new Date().toISOString()))),
          and(eq(providerEvents.status, "processing"), lte(providerEvents.processingStartedAt, new Date(Date.now() - PROVIDER_EVENT_PROCESSING_TIMEOUT_MS).toISOString())))));
    return Number(result.rowCount ?? 0) === 1;
  }

  async updateStatus(affiliateAccountId: string, externalEventId: string, status: ProviderEventStatus, error?: string): Promise<boolean> {
    const values: Record<string, unknown> = { status, error: error?.slice(0, 1000) ?? null };
    if (status === "processed") { values.processedAt = new Date().toISOString(); values.nextAttemptAt = null; }
    if (status === "failed") {
      values.processingStartedAt = null;
      values.retryCount = sql`${providerEvents.retryCount} + 1`;
      values.nextAttemptAt = sql`CASE WHEN ${providerEvents.retryCount} + 1 >= ${PROVIDER_EVENT_MAX_RETRIES} THEN NULL ELSE NOW() + (${retryDelayExpression()}) * INTERVAL '1 millisecond' END`;
    }
    if (status === "processing") values.processingStartedAt = new Date().toISOString();
    const result = await this.db.update(providerEvents).set(values)
      .where(and(eq(providerEvents.affiliateAccountId, affiliateAccountId), eq(providerEvents.externalEventId, externalEventId), eq(providerEvents.status, "processing")));
    return Number(result.rowCount ?? 0) === 1;
  }
}
