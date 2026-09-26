import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { PublicationOperation } from "../domain/publication-operation.js";
import type { PublicationOperationRepository } from "../domain/publication-operation.js";
import { publicationOperations } from "./schema.js";

type DatabaseExecutor = any;
type PublicationOperationRow = typeof publicationOperations.$inferSelect;

const toDomain = (row: PublicationOperationRow): PublicationOperation => ({
  id: row.id,
  contentId: row.contentId,
  jobId: row.jobId,
  provider: row.provider,
  providerOperationId: row.providerOperationId,
  status: row.status as PublicationOperation["status"],
  externalPostId: row.externalPostId ?? undefined,
  lastError: row.lastError ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const toRow = (operation: PublicationOperation) => ({
  id: operation.id,
  contentId: operation.contentId,
  jobId: operation.jobId,
  provider: operation.provider,
  providerOperationId: operation.providerOperationId,
  status: operation.status,
  externalPostId: operation.externalPostId ?? null,
  lastError: operation.lastError ?? null,
  createdAt: operation.createdAt,
  updatedAt: operation.updatedAt
});

export class DrizzlePublicationOperationRepository implements PublicationOperationRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<PublicationOperation[]> {
    return (await this.db.select().from(publicationOperations)).map(toDomain);
  }

  async listReconciliationCandidates(updatedBefore: Date, limit: number): Promise<PublicationOperation[]> {
    const rows = await this.db.select().from(publicationOperations)
      .where(and(
        inArray(publicationOperations.status, ["accepted", "processing"]),
        lte(publicationOperations.updatedAt, updatedBefore.toISOString())
      ))
      .orderBy(asc(publicationOperations.updatedAt))
      .limit(Math.max(0, limit));
    return rows.map(toDomain);
  }

  async findById(id: string): Promise<PublicationOperation | undefined> {
    const rows = await this.db.select().from(publicationOperations).where(eq(publicationOperations.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async findByProviderOperation(provider: string, providerOperationId: string): Promise<PublicationOperation | undefined> {
    const rows = await this.db.select().from(publicationOperations).where(and(eq(publicationOperations.provider, provider), eq(publicationOperations.providerOperationId, providerOperationId))).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async save(operation: PublicationOperation): Promise<PublicationOperation> {
    const values = toRow(operation);
    const existing = await this.findById(operation.id);
    if (existing) await this.db.update(publicationOperations).set(values).where(eq(publicationOperations.id, operation.id));
    else await this.db.insert(publicationOperations).values(values);
    return operation;
  }

  async saveIfAbsent(operation: PublicationOperation): Promise<PublicationOperation> {
    const rows = await this.db.insert(publicationOperations)
      .values(toRow(operation))
      .onConflictDoNothing({ target: [publicationOperations.provider, publicationOperations.providerOperationId] })
      .returning();
    if (rows[0]) return toDomain(rows[0]);
    const existing = await this.findByProviderOperation(operation.provider, operation.providerOperationId);
    if (!existing) throw new Error("Publication operation insert was skipped but no idempotent operation was found.");
    return existing;
  }

  async transition(id: string, expected: PublicationOperation["status"][], operation: PublicationOperation): Promise<PublicationOperation | undefined> {
    const rows = await this.db.update(publicationOperations)
      .set({
        status: operation.status,
        externalPostId: operation.externalPostId ?? null,
        lastError: operation.lastError ?? null,
        updatedAt: operation.updatedAt
      })
      .where(and(eq(publicationOperations.id, id), inArray(publicationOperations.status, expected)))
      .returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
