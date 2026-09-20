import { randomUUID } from "node:crypto";
import type { EntityId } from "@affiliateos/shared";
import type { PublicationOperation, PublicationOperationRepository, PublicationOperationStatus } from "./publication-operation.js";

const allowedTransitions: Record<PublicationOperationStatus, PublicationOperationStatus[]> = {
  accepted: ["accepted", "processing", "published", "failed"],
  processing: ["processing", "published", "failed"],
  published: ["published"],
  failed: ["failed"]
};

export class PublicationOperationService {
  constructor(private readonly operations: PublicationOperationRepository) {}

  async list(): Promise<PublicationOperation[]> {
    return this.operations.list();
  }

  async create(input: { contentId: EntityId; jobId: EntityId; provider: string; providerOperationId: string; status?: PublicationOperationStatus }, now = new Date()): Promise<PublicationOperation> {
    const existing = await this.operations.findByProviderOperation(input.provider, input.providerOperationId);
    if (existing) return existing;
    const timestamp = now.toISOString();
    const operation: PublicationOperation = {
      id: randomUUID(),
      contentId: input.contentId,
      jobId: input.jobId,
      provider: input.provider,
      providerOperationId: input.providerOperationId,
      status: input.status ?? "accepted",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (this.operations.saveIfAbsent) return this.operations.saveIfAbsent(operation);
    try {
      return await this.operations.save(operation);
    } catch (error) {
      const concurrent = await this.operations.findByProviderOperation(input.provider, input.providerOperationId);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async transition(id: EntityId, status: PublicationOperationStatus, details: { externalPostId?: string; error?: string } = {}, now = new Date()): Promise<PublicationOperation> {
    const operation = await this.operations.findById(id);
    if (!operation) throw new Error("Publication operation does not exist.");
    if (!allowedTransitions[operation.status].includes(status)) return operation;
    const next: PublicationOperation = {
      ...operation,
      status,
      externalPostId: details.externalPostId ?? operation.externalPostId,
      lastError: details.error,
      updatedAt: now.toISOString()
    };
    if (this.operations.transition) {
      const transitioned = await this.operations.transition(id, [operation.status], next);
      return transitioned ?? (await this.operations.findById(id)) ?? operation;
    }
    return this.operations.save(next);
  }
}
