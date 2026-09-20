import { and, eq } from "drizzle-orm";
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
}
