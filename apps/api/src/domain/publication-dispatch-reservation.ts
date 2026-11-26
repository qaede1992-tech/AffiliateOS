import type { EntityId, IsoTimestamp } from "@affiliateos/shared";

export type PublicationDispatchState = "reserved" | "dispatching" | "accepted" | "uncertain" | "needs_reconciliation" | "published" | "failed" | "safe_to_retry";

export interface PublicationDispatchReservation {
  id: EntityId;
  jobId: EntityId;
  contentId: EntityId;
  provider: string;
  state: PublicationDispatchState;
  idempotencyKey: string;
  snapshot: Record<string, unknown>;
  snapshotHash: string;
  dispatchStartedAt?: IsoTimestamp;
  providerOperationId?: string;
  externalPostId?: string;
  lastError?: string;
  resolvedAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PublicationDispatchReservationRepository {
  findByJobProvider(jobId: EntityId, provider: string): Promise<PublicationDispatchReservation | undefined>;
  findActiveByContentProvider(contentId: EntityId, provider: string): Promise<PublicationDispatchReservation | undefined>;
  reserve(reservation: PublicationDispatchReservation): Promise<PublicationDispatchReservation>;
  transition(id: EntityId, expected: PublicationDispatchState[], next: PublicationDispatchReservation): Promise<PublicationDispatchReservation | undefined>;
}

const transitions: Record<PublicationDispatchState, PublicationDispatchState[]> = {
  reserved: ["dispatching", "safe_to_retry", "failed"],
  dispatching: ["accepted", "published", "uncertain", "needs_reconciliation", "failed"],
  accepted: ["needs_reconciliation", "published", "failed"],
  // Ambiguous provider outcomes must never become retryable without a separate,
  // auditable proof that the provider did not publish the content.
  uncertain: ["needs_reconciliation", "accepted"],
  needs_reconciliation: ["accepted", "published", "failed"],
  safe_to_retry: ["reserved", "failed"],
  published: ["published"],
  failed: ["failed"]
};

export const canTransitionPublicationDispatch = (from: PublicationDispatchState, to: PublicationDispatchState): boolean => transitions[from].includes(to);

export class InMemoryPublicationDispatchReservationRepository implements PublicationDispatchReservationRepository {
  private readonly rows = new Map<string, PublicationDispatchReservation>();
  async findByJobProvider(jobId: string, provider: string) {
    return [...this.rows.values()].find((row) => row.jobId === jobId && row.provider === provider);
  }
  async findActiveByContentProvider(contentId: string, provider: string) {
    const active = new Set(["dispatching", "accepted", "uncertain", "needs_reconciliation"]);
    return [...this.rows.values()].find((row) => row.contentId === contentId && row.provider === provider && active.has(row.state));
  }
  async reserve(reservation: PublicationDispatchReservation) {
    // Keep lookup + insert in one synchronous critical section. Awaiting the
    // async lookup here would let concurrent callers both observe no row.
    const existing = [...this.rows.values()].find((row) => row.jobId === reservation.jobId && row.provider === reservation.provider);
    if (existing) return existing;
    this.rows.set(reservation.id, reservation);
    return reservation;
  }
  async transition(id: string, expected: PublicationDispatchState[], next: PublicationDispatchReservation) {
    const current = this.rows.get(id);
    if (!current || !expected.includes(current.state) || !canTransitionPublicationDispatch(current.state, next.state)) return undefined;
    // The reservation's identity, idempotency key and payload snapshot are immutable
    // after the first insert. Only dispatch/reconciliation fields may advance.
    const updated: PublicationDispatchReservation = {
      ...current,
      state: next.state,
      dispatchStartedAt: next.dispatchStartedAt,
      providerOperationId: next.providerOperationId,
      externalPostId: next.externalPostId,
      lastError: next.lastError,
      resolvedAt: next.resolvedAt,
      updatedAt: next.updatedAt
    };
    this.rows.set(id, updated);
    return updated;
  }
}
