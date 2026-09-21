import type { EntityId, IsoTimestamp } from "@affiliateos/shared";

export type PublicationOperationStatus = "accepted" | "processing" | "published" | "failed";

export interface PublicationOperation {
  id: EntityId;
  contentId: EntityId;
  jobId: EntityId;
  provider: string;
  providerOperationId: string;
  status: PublicationOperationStatus;
  externalPostId?: string;
  lastError?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PublicationOperationRepository {
  list(): Promise<PublicationOperation[]>;
  findById(id: EntityId): Promise<PublicationOperation | undefined>;
  findByProviderOperation(provider: string, providerOperationId: string): Promise<PublicationOperation | undefined>;
  save(operation: PublicationOperation): Promise<PublicationOperation>;
  saveIfAbsent?(operation: PublicationOperation): Promise<PublicationOperation>;
  transition?(id: EntityId, expected: PublicationOperationStatus[], operation: PublicationOperation): Promise<PublicationOperation | undefined>;
}

export class InMemoryPublicationOperationRepository implements PublicationOperationRepository {
  private readonly operations = new Map<EntityId, PublicationOperation>();

  async list() { return [...this.operations.values()]; }
  async findById(id: EntityId) { return this.operations.get(id); }
  async findByProviderOperation(provider: string, providerOperationId: string) {
    return [...this.operations.values()].find((operation) => operation.provider === provider && operation.providerOperationId === providerOperationId);
  }
  async save(operation: PublicationOperation) { this.operations.set(operation.id, operation); return operation; }
  async saveIfAbsent(operation: PublicationOperation) {
    const existing = await this.findByProviderOperation(operation.provider, operation.providerOperationId);
    if (existing) return existing;
    this.operations.set(operation.id, operation);
    return operation;
  }
  async transition(id: EntityId, expected: PublicationOperationStatus[], operation: PublicationOperation) {
    const current = this.operations.get(id);
    if (!current || !expected.includes(current.status)) return undefined;
    const next: PublicationOperation = {
      ...current,
      status: operation.status,
      externalPostId: operation.externalPostId,
      lastError: operation.lastError,
      updatedAt: operation.updatedAt
    };
    this.operations.set(id, next);
    return next;
  }
}
