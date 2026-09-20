import { randomUUID } from "node:crypto";
import type { EntityId } from "@affiliateos/shared";
import type { PublicationOperation, PublicationOperationRepository, PublicationOperationStatus } from "./publication-operation.js";

export class PublicationOperationService {
  constructor(private readonly operations: PublicationOperationRepository) {}

  async create(input: { contentId: EntityId; jobId: EntityId; provider: string; providerOperationId: string; status?: PublicationOperationStatus }, now = new Date()): Promise<PublicationOperation> {
    const existing = await this.operations.findByProviderOperation(input.provider, input.providerOperationId);
    if (existing) return existing;
    const timestamp = now.toISOString();
    return this.operations.save({ id: randomUUID(), contentId: input.contentId, jobId: input.jobId, provider: input.provider, providerOperationId: input.providerOperationId, status: input.status ?? "accepted", createdAt: timestamp, updatedAt: timestamp });
  }

  async transition(id: EntityId, status: PublicationOperationStatus, details: { externalPostId?: string; error?: string } = {}, now = new Date()): Promise<PublicationOperation> {
    const operation = await this.operations.findById(id);
    if (!operation) throw new Error("Publication operation does not exist.");
    if (operation.status === "published" || operation.status === "failed") return operation;
    return this.operations.save({ ...operation, status, externalPostId: details.externalPostId ?? operation.externalPostId, lastError: details.error, updatedAt: now.toISOString() });
  }
}
