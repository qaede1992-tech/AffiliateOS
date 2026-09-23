import { randomUUID } from "node:crypto";
import type {
  Affiliate,
  Commission,
  Conversion,
  ConversionStatus,
  CreateAffiliateRequest,
  CreateConversionRequest,
  CreateOfferRequest,
  Offer
} from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { ConversionRepository, Repository, TransactionManager } from "./repository.js";

const now = () => new Date().toISOString();

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export class AffiliateService {
  constructor(private readonly affiliates: Repository<Affiliate>) {}

  list(): Promise<Affiliate[]> {
    return this.affiliates.list();
  }

  async create(input: CreateAffiliateRequest): Promise<Affiliate> {
    const affiliate: Affiliate = {
      id: randomUUID(),
      name: input.name,
      email: input.email,
      status: "active",
      createdAt: now()
    };
    return this.affiliates.save(affiliate);
  }
}

export class OfferService {
  constructor(private readonly offers: Repository<Offer>) {}

  list(): Promise<Offer[]> {
    return this.offers.list();
  }

  async create(input: CreateOfferRequest): Promise<Offer> {
    const offer: Offer = {
      id: randomUUID(),
      name: input.name,
      status: input.status,
      commissionRateBps: input.commissionRateBps,
      createdAt: now()
    };
    return this.offers.save(offer);
  }
}

export class ConversionService {
  constructor(
    private readonly conversions: ConversionRepository,
    private readonly commissions: import("./repository.js").CommissionRepository,
    private readonly affiliates: Repository<Affiliate>,
    private readonly offers: Repository<Offer>,
    private readonly transactionManager: TransactionManager
  ) {}

  list(): Promise<Conversion[]> {
    return this.conversions.list();
  }

  async reconcileProviderState(id: string, status: ConversionStatus, commissionCents?: number): Promise<Conversion> {
    const conversion = await this.conversions.findById(id);
    if (!conversion) throw new DomainError("CONVERSION_NOT_FOUND", "The conversion does not exist.", 404);
    const updated: Conversion = { ...conversion, status };
    await this.conversions.save(updated);
    const commissions = await this.commissions.list();
    const commission = commissions.find((item) => item.conversionId === id);
    if (commission) {
      await this.commissions.save({ ...commission, amountCents: commissionCents ?? commission.amountCents, status: status === "pending" ? "pending" : "approved" });
    }
    return updated;
  }

  async create(input: CreateConversionRequest): Promise<Conversion> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey) {
      const existing = await this.conversions.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.affiliateId !== input.affiliateId || existing.offerId !== input.offerId || existing.amountCents !== input.amountCents) {
          throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "The idempotency key was already used for a different conversion.", 409);
        }
        return existing;
      }
    }

    const affiliate = await this.affiliates.findById(input.affiliateId);
    if (!affiliate) {
      throw new DomainError("AFFILIATE_NOT_FOUND", "The affiliate does not exist.", 404);
    }

    const offer = await this.offers.findById(input.offerId);
    if (!offer) {
      throw new DomainError("OFFER_NOT_FOUND", "The offer does not exist.", 404);
    }
    if (offer.status !== "active") {
      throw new DomainError("OFFER_NOT_ACTIVE", "Conversions require an active offer.");
    }

    const conversion: Conversion = {
      id: randomUUID(),
      affiliateId: input.affiliateId,
      offerId: input.offerId,
      amountCents: input.amountCents,
      status: "pending",
      occurredAt: input.occurredAt ?? now(),
      idempotencyKey
    };
    try {
      return await this.transactionManager.run(async ({ conversions, commissions }) => {
        await conversions.save(conversion);
        await commissions.save({
          id: randomUUID(),
          conversionId: conversion.id,
          affiliateId: affiliate.id,
          amountCents: Math.round((conversion.amountCents * offer.commissionRateBps) / 10_000),
          status: "pending",
          createdAt: now()
        });
        return conversion;
      });
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const raced = await this.conversions.findByIdempotencyKey(idempotencyKey);
        if (raced) {
          if (raced.affiliateId !== input.affiliateId || raced.offerId !== input.offerId || raced.amountCents !== input.amountCents) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "The idempotency key was already used for a different conversion.", 409);
          }
          return raced;
        }
      }
      throw error;
    }
  }
}

export class CommissionService {
  constructor(private readonly commissions: Repository<Commission>) {}

  list(): Promise<Commission[]> {
    return this.commissions.list();
  }
}
