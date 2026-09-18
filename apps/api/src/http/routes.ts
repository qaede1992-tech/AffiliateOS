import type { FastifyInstance } from "fastify";
import type {
  Affiliate,
  Commission,
  Conversion,
  CreateAffiliateRequest,
  CreateConversionRequest,
  CreateOfferRequest,
  ListResponse,
  Offer,
  Product,
  ProductOpportunity
} from "@affiliateos/shared";
import type { Services } from "../domain/container.js";
import {
  createAffiliateSchema,
  createConversionSchema,
  createOfferSchema,
  scoreProductSchema
} from "./validation.js";
import { ProductOpportunityService } from "../domain/foundations.js";

const list = <T>(data: T[]): ListResponse<T> => ({ data });

export function registerResourceRoutes(app: FastifyInstance, services: Services): void {
  app.get<{ Reply: ListResponse<Affiliate> }>("/api/v1/affiliates", async () => list(await services.affiliates.list()));
  app.post<{ Body: CreateAffiliateRequest; Reply: Affiliate }>("/api/v1/affiliates", async (request, reply) => {
    return reply.status(201).send(await services.affiliates.create(createAffiliateSchema.parse(request.body)));
  });

  app.get<{ Reply: ListResponse<Offer> }>("/api/v1/offers", async () => list(await services.offers.list()));
  app.post<{ Body: CreateOfferRequest; Reply: Offer }>("/api/v1/offers", async (request, reply) => {
    return reply.status(201).send(await services.offers.create(createOfferSchema.parse(request.body)));
  });

  app.get<{ Reply: ListResponse<Conversion> }>("/api/v1/conversions", async () => list(await services.conversions.list()));
  app.post<{ Body: CreateConversionRequest; Reply: Conversion }>("/api/v1/conversions", async (request, reply) => {
    return reply.status(201).send(await services.conversions.create(createConversionSchema.parse(request.body)));
  });

  app.get<{ Reply: ListResponse<Commission> }>("/api/v1/commissions", async () => list(await services.commissions.list()));

  // Scores caller-supplied, real product signals only; it never fabricates marketplace data.
  app.post<{ Body: { product: Product; commissionRateBps?: number; audienceRelevance?: number }; Reply: ProductOpportunity }>("/api/v1/product-opportunities/score", async (request) => {
    const input = scoreProductSchema.parse(request.body);
    return new ProductOpportunityService().score(input.product, input.commissionRateBps, input.audienceRelevance);
  });
}