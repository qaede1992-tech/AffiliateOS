import { and, eq, inArray } from "drizzle-orm";
import { canTransitionPublicationDispatch, type PublicationDispatchReservation, type PublicationDispatchReservationRepository, type PublicationDispatchState } from "../domain/publication-dispatch-reservation.js";
import { publicationDispatchReservations } from "./schema.js";

type DatabaseExecutor = any;
type Row = typeof publicationDispatchReservations.$inferSelect;

const toDomain = (row: Row): PublicationDispatchReservation => ({
  id: row.id, jobId: row.jobId, contentId: row.contentId, provider: row.provider,
  state: row.state as PublicationDispatchState, idempotencyKey: row.idempotencyKey,
  snapshot: row.snapshot, snapshotHash: row.snapshotHash,
  dispatchStartedAt: row.dispatchStartedAt ?? undefined,
  providerOperationId: row.providerOperationId ?? undefined,
  externalPostId: row.externalPostId ?? undefined,
  lastError: row.lastError ?? undefined, resolvedAt: row.resolvedAt ?? undefined,
  createdAt: row.createdAt, updatedAt: row.updatedAt
});

const toRow = (value: PublicationDispatchReservation) => ({
  id: value.id, jobId: value.jobId, contentId: value.contentId, provider: value.provider,
  state: value.state, idempotencyKey: value.idempotencyKey, snapshot: value.snapshot,
  snapshotHash: value.snapshotHash, dispatchStartedAt: value.dispatchStartedAt ?? null,
  providerOperationId: value.providerOperationId ?? null, externalPostId: value.externalPostId ?? null, lastError: value.lastError ?? null,
  resolvedAt: value.resolvedAt ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt
});

export class DrizzlePublicationDispatchReservationRepository implements PublicationDispatchReservationRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findByJobProvider(jobId: string, provider: string): Promise<PublicationDispatchReservation | undefined> {
    const rows = await this.db.select().from(publicationDispatchReservations)
      .where(and(eq(publicationDispatchReservations.jobId, jobId), eq(publicationDispatchReservations.provider, provider))).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async findActiveByContentProvider(contentId: string, provider: string): Promise<PublicationDispatchReservation | undefined> {
    const rows = await this.db.select().from(publicationDispatchReservations)
      .where(and(
        eq(publicationDispatchReservations.contentId, contentId),
        eq(publicationDispatchReservations.provider, provider),
        inArray(publicationDispatchReservations.state, ["dispatching", "accepted", "uncertain", "needs_reconciliation"])
      ))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async reserve(reservation: PublicationDispatchReservation): Promise<PublicationDispatchReservation> {
    const rows = await this.db.insert(publicationDispatchReservations).values(toRow(reservation))
      .onConflictDoNothing({ target: [publicationDispatchReservations.jobId, publicationDispatchReservations.provider] })
      .returning();
    if (rows[0]) return toDomain(rows[0]);
    const existing = await this.findByJobProvider(reservation.jobId, reservation.provider);
    if (!existing) throw new Error("Publication dispatch reservation conflict could not be resolved.");
    return existing;
  }

  async transition(id: string, expected: PublicationDispatchState[], next: PublicationDispatchReservation): Promise<PublicationDispatchReservation | undefined> {
    // Keep PostgreSQL transitions aligned with the domain state machine. A
    // conditional UPDATE alone protects against races, but must not permit an
    // otherwise illegal state jump supplied by a caller.
    const allowedExpected = expected.filter((state) => canTransitionPublicationDispatch(state, next.state));
    if (allowedExpected.length === 0) return undefined;
    const rows = await this.db.update(publicationDispatchReservations).set({
      state: next.state, dispatchStartedAt: next.dispatchStartedAt ?? null,
      providerOperationId: next.providerOperationId ?? null, externalPostId: next.externalPostId ?? null, lastError: next.lastError ?? null,
      resolvedAt: next.resolvedAt ?? null, updatedAt: next.updatedAt
    }).where(and(eq(publicationDispatchReservations.id, id), inArray(publicationDispatchReservations.state, allowedExpected))).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
