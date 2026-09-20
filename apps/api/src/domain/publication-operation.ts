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
}

export class InMemoryPublicationOperationRepository implements PublicationOperationRepository {
  private readonly operations = new Map<EntityId, PublicationOperation>();

  async list() { return [...this.operations.values()]; }
  async findById(id: EntityId) { return this.operations.get(id); }
  async findByProviderOperation(provider: string, providerOperationId: string) {
    return [...this.operations.values()].find((operation) => operation.provider === provider && operation.providerOperationId === providerOperationId);
  }
  async save(operation: PublicationOperation) { this.operations.set(operation.id, operation); return operation; }
}
