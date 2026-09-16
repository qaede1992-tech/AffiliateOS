import { randomUUID } from "node:crypto";
import type {
  Affiliate,
  Commission,
  Conversion,
  CreateAffiliateRequest,
  CreateConversionRequest,
  CreateOfferRequest,
  Offer
} from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { Repository, TransactionManager } from "./repository.js";

const now = () => new Date().toISOString();

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
      status: "active",
      commissionRateBps: input.commissionRateBps,
      createdAt: now()
    };
    return this.offers.save(offer);
  }
}

export class ConversionService {
  constructor(
    private readonly conversions: Repository<Conversion>,
    private readonly commissions: Repository<Commission>,
    private readonly affiliates: Repository<Affiliate>,
    private readonly offers: Repository<Offer>,
    private readonly transactionManager: TransactionManager
  ) {}

  list(): Promise<Conversion[]> {
    return this.conversions.list();
  }

  async create(input: CreateConversionRequest): Promise<Conversion> {
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
      occurredAt: input.occurredAt ?? now()
    };
    return this.transactionManager.run(async ({ conversions, commissions }) => {
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
  }
}

export class CommissionService {
  constructor(private readonly commissions: Repository<Commission>) {}

  list(): Promise<Commission[]> {
    return this.commissions.list();
  }
}