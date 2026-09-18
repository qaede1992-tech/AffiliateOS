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
  scoreProductSchema,
  marketplaceLinkSchema, marketplaceProductParamsSchema, marketplaceSearchSchema, marketplaceSlugSchema, createMarketplaceConnectionSchema, marketplaceEnableSchema, updateMarketplaceConnectionSchema
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

  app.get("/api/v1/marketplaces/providers", async () => list(await services.marketplace.listProviders()));
  app.get("/api/v1/marketplaces", async () => list(await services.marketplace.listConnections()));
  app.post("/api/v1/marketplaces", async (request, reply) => {
    const connection = await services.marketplace.createConnection(createMarketplaceConnectionSchema.parse(request.body));
    request.log.info({ event: "marketplace_connection_created", connectionSlug: connection.slug, providerSlug: connection.providerSlug });
    return reply.status(201).send(connection);
  });
  app.get("/api/v1/marketplaces/:connectionSlug", async (request) => services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug));
  app.patch("/api/v1/marketplaces/:connectionSlug", async (request) => {
    const connection = await services.marketplace.updateConnection(marketplaceSlugSchema.parse(request.params).connectionSlug, updateMarketplaceConnectionSchema.parse(request.body));
    request.log.info({ event: "marketplace_connection_updated", connectionSlug: connection.slug, providerSlug: connection.providerSlug });
    return connection;
  });
  app.put("/api/v1/marketplaces/:connectionSlug/enabled", async (request) => {
    const connection = await services.marketplace.setEnabled(marketplaceSlugSchema.parse(request.params).connectionSlug, marketplaceEnableSchema.parse(request.body).enabled);
    request.log.info({ event: "marketplace_connection_enabled_changed", connectionSlug: connection.slug, enabled: connection.enabled });
    return connection;
  });
  app.post("/api/v1/marketplaces/:connectionSlug/test", async (request) => {
    const connection = await services.marketplace.testConnection(marketplaceSlugSchema.parse(request.params).connectionSlug);
    request.log.info({ event: "marketplace_connection_tested", connectionSlug: connection.slug, healthStatus: connection.healthStatus });
    return connection;
  });
  app.get("/api/v1/marketplaces/:connectionSlug/health", async (request) => {
    const connection = await services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug);
    return { status: connection.healthStatus, error: connection.healthError, metadata: connection.healthMetadata, lastCheckedAt: connection.lastCheckedAt, lastSuccessfulCheckAt: connection.lastSuccessfulCheckAt, lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt };
  });
  app.post("/api/v1/marketplaces/:connectionSlug/products/discover", async (request) => {
    const { connectionSlug } = marketplaceSlugSchema.parse(request.params);
    return list(await services.marketplace.discoverProducts(connectionSlug));
  });
  app.get("/api/v1/marketplaces/:connectionSlug/products/search", async (request) => {
    const { connectionSlug, query } = marketplaceSearchSchema.parse({ ...(request.params as object), ...(request.query as object) });
    return list(await services.marketplace.searchProducts(connectionSlug, query));
  });
  app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId", async (request) => {
    const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params);
    return services.marketplace.getProduct(connectionSlug, externalProductId);
  });
  app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers", async (request) => {
    const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params);
    return list(await services.marketplace.getOffers(connectionSlug, externalProductId));
  });
  app.post("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers/:externalOfferId/affiliate-link", async (request) => {
    const input = marketplaceLinkSchema.parse(request.params);
    return services.marketplace.generateAffiliateLink(input.connectionSlug, input.externalProductId, input.externalOfferId);
  });
}
