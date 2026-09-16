import { eq } from "drizzle-orm";
import type { Affiliate, Commission, Conversion, Offer } from "@affiliateos/shared";
import { affiliates, commissions, conversions, offers } from "./schema.js";
import type { Repository, RepositorySet, TransactionManager } from "../domain/repository.js";

type DatabaseExecutor = any;

const toAffiliate = (row: typeof affiliates.$inferSelect): Affiliate => ({
  id: row.id,
  name: row.name,
  email: row.email,
  status: row.status as Affiliate["status"],
  createdAt: row.createdAt
});

const toOffer = (row: typeof offers.$inferSelect): Offer => ({
  id: row.id,
  name: row.name,
  status: row.status as Offer["status"],
  commissionRateBps: row.commissionRateBps,
  createdAt: row.createdAt
});

const toConversion = (row: typeof conversions.$inferSelect): Conversion => ({
  id: row.id,
  affiliateId: row.affiliateId,
  offerId: row.offerId,
  amountCents: row.amountCents,
  status: row.status as Conversion["status"],
  occurredAt: row.occurredAt
});

const toCommission = (row: typeof commissions.$inferSelect): Commission => ({
  id: row.id,
  conversionId: row.conversionId,
  affiliateId: row.affiliateId,
  amountCents: row.amountCents,
  status: row.status as Commission["status"],
  createdAt: row.createdAt
});

class DrizzleRepository<T extends { id: string }, Row extends { id: string }> implements Repository<T> {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly table: any,
    private readonly toDomain: (row: Row) => T,
    private readonly toRow: (entity: T) => Row
  ) {}

  async list(): Promise<T[]> {
    const rows = await this.db.select().from(this.table);
    return rows.map(this.toDomain);
  }

  async findById(id: string): Promise<T | undefined> {
    const rows = await this.db.select().from(this.table).where(eq(this.table.id, id)).limit(1);
    const row = rows[0] as Row | undefined;
    return row ? this.toDomain(row) : undefined;
  }

  async save(entity: T): Promise<T> {
    await this.db.insert(this.table).values(this.toRow(entity));
    return entity;
  }
}

const createRepositories = (db: DatabaseExecutor): RepositorySet => ({
  affiliates: new DrizzleRepository(db, affiliates, toAffiliate, (entity: Affiliate) => ({
    id: entity.id,
    name: entity.name,
    email: entity.email,
    status: entity.status,
    createdAt: entity.createdAt
  })),
  offers: new DrizzleRepository(db, offers, toOffer, (entity: Offer) => ({
    id: entity.id,
    name: entity.name,
    status: entity.status,
    commissionRateBps: entity.commissionRateBps,
    createdAt: entity.createdAt
  })),
  conversions: new DrizzleRepository(db, conversions, toConversion, (entity: Conversion) => ({
    id: entity.id,
    affiliateId: entity.affiliateId,
    offerId: entity.offerId,
    amountCents: entity.amountCents,
    status: entity.status,
    occurredAt: entity.occurredAt
  })),
  commissions: new DrizzleRepository(db, commissions, toCommission, (entity: Commission) => ({
    id: entity.id,
    conversionId: entity.conversionId,
    affiliateId: entity.affiliateId,
    amountCents: entity.amountCents,
    status: entity.status,
    createdAt: entity.createdAt
  }))
});

export class DrizzleTransactionManager implements TransactionManager {
  constructor(private readonly db: DatabaseExecutor) {}

  run<T>(work: (repositories: Pick<RepositorySet, "conversions" | "commissions">) => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction: DatabaseExecutor) => {
      const repositories = createRepositories(transaction);
      return work({ conversions: repositories.conversions, commissions: repositories.commissions });
    });
  }
}

export const createPostgresRepositories = (db: DatabaseExecutor): RepositorySet => createRepositories(db);