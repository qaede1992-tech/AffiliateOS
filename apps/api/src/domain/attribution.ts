import type { Conversion, ConversionAttribution, CreateConversionAttributionRequest, TrackingLink } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { Repository } from "./repository.js";

const now = () => new Date().toISOString();

export interface ConversionAttributionRepository {
  list(): Promise<ConversionAttribution[]>;
  findByConversion(conversionId: string): Promise<ConversionAttribution | undefined>;
  save(entity: ConversionAttribution): Promise<ConversionAttribution>;
}

export class InMemoryConversionAttributionRepository implements ConversionAttributionRepository {
  private readonly values = new Map<string, ConversionAttribution>();
  async list(): Promise<ConversionAttribution[]> { return [...this.values.values()]; }
  async findByConversion(conversionId: string): Promise<ConversionAttribution | undefined> { return this.values.get(conversionId); }
  async save(entity: ConversionAttribution): Promise<ConversionAttribution> { this.values.set(entity.conversionId, entity); return entity; }
}

export class ConversionAttributionService {
  constructor(
    private readonly conversions: Repository<Conversion>,
    private readonly trackingLinks: Repository<TrackingLink>,
    private readonly attributions: ConversionAttributionRepository
  ) {}

  async get(conversionId: string): Promise<ConversionAttribution | undefined> {
    return this.attributions.findByConversion(conversionId);
  }

  async create(conversionId: string, input: CreateConversionAttributionRequest): Promise<ConversionAttribution> {
    const conversion = await this.conversions.findById(conversionId);
    if (!conversion) throw new DomainError("CONVERSION_NOT_FOUND", "The conversion does not exist.", 404);
    const trackingLink = await this.trackingLinks.findById(input.trackingLinkId);
    if (!trackingLink) throw new DomainError("TRACKING_LINK_NOT_FOUND", "The tracking link does not exist.", 404);
    if (trackingLink.status !== "active") throw new DomainError("TRACKING_LINK_NOT_ACTIVE", "Conversions can only be attributed to active tracking links.");
    const existing = await this.attributions.findByConversion(conversionId);
    if (existing) {
      if (existing.trackingLinkId === input.trackingLinkId) return existing;
      throw new DomainError("CONVERSION_ALREADY_ATTRIBUTED", "The conversion is already attributed to another tracking link.", 409);
    }
    return this.attributions.save({ conversionId: conversion.id, trackingLinkId: trackingLink.id, attributedAt: now() });
  }
}
