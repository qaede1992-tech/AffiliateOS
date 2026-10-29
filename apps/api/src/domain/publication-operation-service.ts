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

  async listByJobId(jobId: EntityId): Promise<PublicationOperation[]> {
    return this.operations.listByJobId(jobId);
  }

  async listReconciliationCandidates(updatedBefore: Date, limit: number): Promise<PublicationOperation[]> {
    if (this.operations.listReconciliationCandidates) {
      return this.operations.listReconciliationCandidates(updatedBefore, limit);
    }
    return (await this.operations.list())
      .filter((operation) =>
        (operation.status === "accepted" || operation.status === "processing") &&
        new Date(operation.updatedAt).getTime() <= updatedBefore.getTime()
      )
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(0, Math.max(0, limit));
  }

  async create(input: { contentId: EntityId; jobId: EntityId; provider: string; providerOperationId: string; status?: PublicationOperationStatus }, now = new Date()): Promise<PublicationOperation> {
    // Instagram creates a media container before the operation is persisted. If a retry
    // races after that external call, reuse the job's existing non-failed operation so a
    // second container cannot be reconciled into a second public post. Keep other providers
    // unchanged until their own duplicate-publication behavior is evidenced.
    if (input.provider === "instagram-graph") {
      const existingForJob = (await this.operations.listByJobId(input.jobId))
        .find((operation) => operation.provider === input.provider && operation.status !== "failed");
      if (existingForJob) return existingForJob;
    }
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
    if (this.operations.saveIfAbsent) {
      try {
        return await this.operations.saveIfAbsent(operation);
      } catch (error) {
        if (input.provider === "instagram-graph") {
          const concurrent = (await this.operations.listByJobId(input.jobId))
            .find((candidate) => candidate.provider === input.provider && candidate.status !== "failed");
          if (concurrent) return concurrent;
        }
        throw error;
      }
    }
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
      lastError: details.error ?? operation.lastError,
      updatedAt: now.toISOString()
    };
    if (this.operations.transition) {
      const transitioned = await this.operations.transition(id, [operation.status], next);
      return transitioned ?? (await this.operations.findById(id)) ?? operation;
    }
    return this.operations.save(next);
  }
}
