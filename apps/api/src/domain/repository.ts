import type { EntityId } from "@affiliateos/shared";

export interface Repository<T extends { id: EntityId }> {
  list(): Promise<T[]>;
  findById(id: EntityId): Promise<T | undefined>;
  save(entity: T): Promise<T>;
}

export class InMemoryRepository<T extends { id: EntityId }> implements Repository<T> {
  private readonly entities = new Map<EntityId, T>();

  async list(): Promise<T[]> {
    return [...this.entities.values()];
  }

  async findById(id: EntityId): Promise<T | undefined> {
    return this.entities.get(id);
  }

  async save(entity: T): Promise<T> {
    this.entities.set(entity.id, entity);
    return entity;
  }
}

export interface RepositorySet {
  affiliates: Repository<import("@affiliateos/shared").Affiliate>;
  offers: Repository<import("@affiliateos/shared").Offer>;
  conversions: Repository<import("@affiliateos/shared").Conversion>;
  commissions: Repository<import("@affiliateos/shared").Commission>;
}

export interface TransactionManager {
  run<T>(work: (repositories: Pick<RepositorySet, "conversions" | "commissions">) => Promise<T>): Promise<T>;
}