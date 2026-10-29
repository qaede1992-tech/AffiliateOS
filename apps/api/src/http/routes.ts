import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Affiliate, Commission, Conversion, CreateAffiliateRequest, CreateConversionRequest, CreateOfferRequest, ListResponse, Offer, Product, ProductOpportunity } from "@affiliateos/shared";
import type { Services } from "../domain/container.js";
import type { ProviderEventStore } from "../db/provider-events.js";
import { captureRawBody, getRawBody } from "./raw-body.js";
import { createAffiliateSchema, createConversionSchema, createOfferSchema, scoreProductSchema, conversionIdSchema, createConversionAttributionSchema, marketplaceLinkSchema, marketplaceProductParamsSchema, marketplaceSearchSchema, marketplaceSlugSchema, marketplaceConversionSyncSchema, createMarketplaceConnectionSchema, marketplaceEnableSchema, bindAffiliateAccountSchema, updateMarketplaceConnectionSchema, createCampaignSchema, updateCampaignSchema, campaignIdSchema, campaignOfferParamsSchema, autonomousRunIdSchema, autonomousRunQuerySchema, autonomousDecisionAuditQuerySchema, trackingLinkQuerySchema, createTrackingLinkSchema, trackingLinkIdSchema, recordClickSchema, contentQuerySchema, contentIdSchema, contentStoryProductsSchema, attachProductMediaSchema, createContentSchema, updateContentSchema, socialAccountIdSchema, createSocialAccountSchema, updateSocialAccountSchema, socialCredentialRotationSchema, socialOAuthStartSchema, socialOAuthCallbackSchema, publicationJobIdSchema, tiktokPublicationApprovalSchema, importShopeeAffiliateFeedSchema, importShopeeAffiliateCsvSchema, productMediaParamsSchema, updateProductMediaSchema, shopeeCommissionReportSchema } from "./validation.js";
import { ProductOpportunityService } from "../domain/foundations.js";
import { auditSecurityEvent } from "./app-audit.js";
import { requireOperator } from "./auth.js";
import { buildPerformanceIndex } from "../domain/performance-index.js";
import { TikTokProviderRequestError } from "../domain/tiktok-content-posting-client.js";
import { parseShopeeAffiliateCsv } from "../domain/shopee-affiliate-csv.js";
import { Readable } from "node:stream";
const list = <T>(data: T[]): ListResponse<T> => ({ data });
const writeGuard = { preHandler: requireOperator };
export function registerResourceRoutes(app: FastifyInstance, services: Services, providerEvents?: ProviderEventStore): void {
  // Keep the upload parser encapsulated so the global JSON/body parser and 1 MiB limit remain unchanged.
  app.register(async (mediaApp) => {
    mediaApp.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
      // No parseAs option: preserve the incoming Node stream instead of buffering it.
      done(null, payload);
    });
    mediaApp.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?", 1)[0] !== "/api/v1/content/media-upload") return;
      const role = request.auth?.role;
      if (role !== "admin" && role !== "operator") {
        auditSecurityEvent(request.log, request, "authorization_denied", { reason: "media_upload_requires_operator" });
        return reply.status(403).send({ error: "FORBIDDEN", message: "Operator authorization is required." });
      }
    });
    mediaApp.post<{ Querystring: { contentId?: string; kind?: string }; Body: unknown }>("/api/v1/content/media-upload", { bodyLimit: 45 * 1024 * 1024 }, async (request, reply) => {
      if (!services.mediaUpload) return reply.status(503).send({ error: "MEDIA_UPLOAD_UNAVAILABLE", message: "Media upload is not configured." });
      const contentId = typeof request.query.contentId === "string" ? request.query.contentId.trim() : "";
      const kind = request.query.kind;
      if (!["image", "thumbnail", "video"].includes(kind ?? "")) {
        return reply.status(400).send({ error: "INVALID_MEDIA_KIND", message: "A supported media kind is required." });
      }
      const mimeType = request.headers["content-type"];
      if (typeof mimeType !== "string" || mimeType.trim().toLowerCase() !== "application/octet-stream") {
        return reply.status(415).send({ error: "UNSUPPORTED_MEDIA_TYPE", message: "Send the file as application/octet-stream and declare its media type with X-Media-Mime-Type." });
      }
      const declaredMimeType = request.headers["x-media-mime-type"];
      if (typeof declaredMimeType !== "string") {
        return reply.status(400).send({ error: "MEDIA_MIME_TYPE_REQUIRED", message: "X-Media-Mime-Type is required." });
      }
      const rawLength = request.headers["content-length"];
      const contentLength = typeof rawLength === "string" && /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        return reply.status(411).send({ error: "CONTENT_LENGTH_REQUIRED", message: "A valid Content-Length header is required." });
      }
      if (!(request.body instanceof Readable)) {
        return reply.status(400).send({ error: "MEDIA_STREAM_UNAVAILABLE", message: "The request body could not be streamed." });
      }
      const body = Readable.toWeb(request.body) as ReadableStream<Uint8Array>;
      const abortController = new AbortController();
      const abortUpload = () => abortController.abort(new Error("Media upload client disconnected."));
      const onResponseClose = () => { if (!reply.raw.writableEnded) abortUpload(); };
      request.raw.once("aborted", abortUpload);
      reply.raw.once("close", onResponseClose);
      try {
        const asset = await services.mediaUpload.uploadStream({
          contentId,
          kind: kind as "image" | "thumbnail" | "video",
          mimeType: declaredMimeType,
          body,
          contentLength,
          signal: abortController.signal
        });
        return reply.status(201).send(asset);
      } catch (error) {
        request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "media upload rejected");
        const message = error instanceof Error ? error.message : "";
        if (/does not exist/i.test(message)) return reply.status(404).send({ error: "CONTENT_NOT_FOUND", message: "The target content does not exist." });
        if (/required|UUID|not allowed|MIME type|signature|size limit|Content-Length|duration/i.test(message)) {
          return reply.status(400).send({ error: "INVALID_MEDIA_UPLOAD", message: "The media upload failed validation." });
        }
        return reply.status(502).send({ error: "MEDIA_UPLOAD_FAILED", message: "The media upload could not be completed." });
      } finally {
        request.raw.removeListener("aborted", abortUpload);
        reply.raw.removeListener("close", onResponseClose);
      }
    });
  });
  app.get<{ Params: { code: string } }>("/r/:code", async (request, reply) => { const destination = await services.tracking.redirect(request.params.code, { source: "public-redirect", ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"] } : {}), ...(typeof request.headers.referer === "string" ? { referer: request.headers.referer } : {}) }); return reply.redirect(destination, 302); });
  app.post("/api/v1/publication-jobs/:jobId/confirm", writeGuard, async (request) => { const { jobId } = publicationJobIdSchema.parse(request.params); const approval = tiktokPublicationApprovalSchema.parse(request.body); const job = await services.publicationJobs.confirmWithApproval(jobId, approval); auditSecurityEvent(request.log, request, "publication_job_confirmed", { jobId, privacyLevel: approval.privacyLevel, commercialDisclosureEnabled: approval.commercialDisclosureEnabled }); return job; });
  app.get("/api/v1/publication-jobs", writeGuard, async () => list(await services.publicationJobs.list()));
  app.get("/api/v1/social-accounts/:socialAccountId/tiktok/creator-info", writeGuard, async (request, reply) => {
    const { socialAccountId } = socialAccountIdSchema.parse(request.params);
    const account = await services.socialAccounts.getForPublisher(socialAccountId);
    if (account.platform !== "tiktok") return reply.status(400).send({ error: "INVALID_SOCIAL_ACCOUNT_PLATFORM", message: "The social account must be a TikTok account." });
    try {
      return await services.tiktokCreatorInfo.getCreatorInfo(account);
    } catch (error) {
      if (error instanceof TikTokProviderRequestError) {
        request.log.warn({ upstreamStatus: error.upstreamStatus }, "TikTok Creator Info provider request failed");
        return reply.status(502).send({
          error: "TIKTOK_PROVIDER_REQUEST_FAILED",
          message: "TikTok did not accept the Creator Info request. Verify the account connection and try again."
        });
      }
      throw error;
    }
  });
  app.get("/api/v1/publication-jobs/:jobId", writeGuard, async (request, reply) => { const { jobId } = publicationJobIdSchema.parse(request.params); const job = await services.publicationJobs.get(jobId); if (!job) return reply.status(404).send({ error: "PUBLICATION_JOB_NOT_FOUND", message: "Publication job does not exist." }); const content = await services.content.get(job.contentId); return { ...job, content }; });
  app.get("/api/v1/publishers/readiness", writeGuard, async () => list(await services.publisherReadiness.list()));
  app.get("/api/v1/autonomous/status", writeGuard, async () => services.autonomousScheduler.status);
  app.get("/api/v1/autonomous/preview", writeGuard, async () => services.autonomousScheduler.previewSelection());
  app.get("/api/v1/autonomous/health", writeGuard, async () => {
    const [accepted, processing, failed, recoverable, publishers] = await Promise.all([
      services.autonomousRuns.list({ status: "accepted", limit: 100 }),
      services.autonomousRuns.list({ status: "processing", limit: 100 }),
      services.autonomousRuns.list({ status: "failed", limit: 100 }),
      services.autonomousRuns.listRecoverable(),
      services.publisherReadiness.list()
    ]);
    const scheduler = services.autonomousScheduler.status;
    const blockedPublishers = publishers.filter((publisher) => publisher.status !== "ready");
    const status = !scheduler.running
      ? "disabled"
      : scheduler.lastError || blockedPublishers.length || recoverable.length
        ? "degraded"
        : "healthy";
    return {
      status,
      scheduler: {
        running: scheduler.running,
        active: scheduler.active,
        lastStartedAt: scheduler.lastStartedAt,
        lastCompletedAt: scheduler.lastCompletedAt,
        lastError: scheduler.lastError
      },
      publishers,
      runs: {
        accepted: accepted.length,
        processing: processing.length,
        failed: failed.length,
        recoverable: recoverable.length
      }
    };
  });
  app.get("/api/v1/autonomous/decision-audits", writeGuard, async (request, reply) => {
    if (!services.autonomousDecisionAudits) return reply.status(503).send({ error: "AUTONOMOUS_AUDIT_UNAVAILABLE", message: "Autonomous decision audit persistence is unavailable." });
    return list(await services.autonomousDecisionAudits.list(autonomousDecisionAuditQuerySchema.parse(request.query)));
  });
  app.get("/api/v1/autonomous/runs", writeGuard, async (request) => { const query = autonomousRunQuerySchema.parse(request.query); return list(await services.autonomousRuns.list(query)); });
  app.get("/api/v1/autonomous/runs/:runId", writeGuard, async (request) => { const { runId } = autonomousRunIdSchema.parse(request.params); return services.autonomousRuns.findById(runId); });
  app.post("/api/v1/autonomous/runs/:runId/retry", writeGuard, async (request) => { const { runId } = autonomousRunIdSchema.parse(request.params); const run = await services.autonomousRuns.retry(runId); auditSecurityEvent(request.log, request, "autonomous_run_retry_requested", { runId, status: run.status, attemptCount: String(run.attemptCount) }); return run; });
  app.post("/api/v1/autonomous/cycles/run", writeGuard, async (request, reply) => {
    const result = await services.autonomousScheduler.runNow();
    const status = services.autonomousScheduler.status;
    auditSecurityEvent(request.log, request, "autonomous_cycle_triggered", {
      executed: Boolean(result),
      active: status.active,
      skipReason: status.lastSkipReason
    });
    if (result) return reply.status(200).send({ status: "completed", result });
    if (status.active) return reply.status(202).send({ status: "already_running" });
    if (status.lastSkipReason === "lock_busy") return reply.status(202).send({ status: "lock_busy" });
    if (status.lastSkipReason === "already_running") return reply.status(202).send({ status: "already_running" });
    return reply.status(500).send({ status: "failed", error: status.lastError ?? "Autonomous cycle failed." });
  });
  app.post("/api/v1/marketplaces/:connectionSlug/events", { preParsing: captureRawBody }, async (request, reply) => {
    if (!providerEvents) return reply.status(503).send({ error: "PROVIDER_EVENT_STORE_UNAVAILABLE", message: "Provider event persistence is unavailable." });
    const { connectionSlug } = marketplaceSlugSchema.parse(request.params); const rawBody = getRawBody(request); if (!rawBody) return reply.status(400).send({ error: "RAW_BODY_UNAVAILABLE", message: "The provider event body could not be verified." });
    const verification = await services.marketplace.verifyProviderEvent(connectionSlug, rawBody, { signature: request.headers["x-provider-signature"] as string | undefined, timestamp: request.headers["x-provider-timestamp"] as string | undefined });
    if (!verification.valid) return reply.status(400).send({ error: "INVALID_PROVIDER_EVENT_SIGNATURE", message: "The provider event signature is invalid or expired." });
    const payload = request.body as Record<string, unknown>; const externalEventId = typeof payload.id === "string" ? payload.id.trim() : ""; const eventType = typeof payload.type === "string" ? payload.type.trim() : "";
    if (!externalEventId || externalEventId.length > 255 || !eventType || eventType.length > 100) return reply.status(400).send({ error: "INVALID_PROVIDER_EVENT", message: "Provider events require valid id and type fields." });
    const account = await services.marketplace.getAffiliateAccount(connectionSlug); const inserted = await providerEvents.insertIfNew({ id: randomUUID(), affiliateAccountId: account.id, externalEventId, eventType, payload, signatureVersion: verification.version, receivedAt: new Date().toISOString() }); return reply.status(inserted ? 202 : 200).send({ accepted: true, duplicate: !inserted, externalEventId });
  });
  app.get<{ Reply: ListResponse<Affiliate> }>("/api/v1/affiliates", async () => list(await services.affiliates.list())); app.post<{ Body: CreateAffiliateRequest; Reply: Affiliate }>("/api/v1/affiliates", writeGuard, async (request, reply) => reply.status(201).send(await services.affiliates.create(createAffiliateSchema.parse(request.body))));
  app.get<{ Reply: ListResponse<Offer> }>("/api/v1/offers", async () => list(await services.offers.list())); app.post<{ Body: CreateOfferRequest; Reply: Offer }>("/api/v1/offers", writeGuard, async (request, reply) => reply.status(201).send(await services.offers.create(createOfferSchema.parse(request.body))));
  app.get<{ Reply: ListResponse<Conversion> }>("/api/v1/conversions", async () => list(await services.conversions.list())); app.post<{ Body: CreateConversionRequest; Reply: Conversion }>("/api/v1/conversions", writeGuard, async (request, reply) => reply.status(201).send(await services.conversions.create(createConversionSchema.parse(request.body))));
  app.post("/api/v1/conversions/:conversionId/attribution", writeGuard, async (request, reply) => { const params = conversionIdSchema.parse(request.params); const attribution = await services.attribution.create(params.conversionId, createConversionAttributionSchema.parse(request.body)); return reply.status(201).send(attribution); }); app.get("/api/v1/conversions/:conversionId/attribution", async (request) => { const { conversionId } = conversionIdSchema.parse(request.params); const attribution = await services.attribution.get(conversionId); return attribution ?? { conversionId, attributed: false }; });
  app.get<{ Reply: ListResponse<Commission> }>("/api/v1/commissions", async () => list(await services.commissions.list())); app.post("/api/v1/product-opportunities/score", writeGuard, async (request) => { const input = scoreProductSchema.parse(request.body); return new ProductOpportunityService().score(input.product, input.commissionRateBps, input.audienceRelevance); });
  app.get("/api/v1/marketplaces/providers", async () => list(await services.marketplace.listProviders())); app.post("/api/v1/marketplaces/shopee-affiliate-feed/import", writeGuard, async (request, reply) => reply.status(201).send(await services.marketplace.importShopeeAffiliateFeed(importShopeeAffiliateFeedSchema.parse(request.body)))); app.post("/api/v1/marketplaces/shopee-affiliate-feed/import-csv", writeGuard, async (request, reply) => {
    const input = importShopeeAffiliateCsvSchema.parse(request.body);
    let parsed;
    try { parsed = parseShopeeAffiliateCsv(input.csv); }
    catch (error) { return reply.status(400).send({ error: "INVALID_SHOPEE_AFFILIATE_CSV", message: error instanceof Error ? error.message : "CSV Shopee tidak valid." }); }
    if (parsed.errors.length > 0 || parsed.rows.length === 0) return reply.status(400).send({ error: "INVALID_SHOPEE_AFFILIATE_CSV", message: "CSV berisi baris yang tidak valid; tidak ada data yang diimpor.", errors: parsed.errors, validRows: parsed.rows.length });
    const result = await services.marketplace.importShopeeAffiliateFeed({
      affiliateId: input.affiliateId,
      ...(input.sourceReference ? { sourceReference: input.sourceReference } : {}),
      items: parsed.rows.map((row) => ({
        externalProductId: row.externalProductId,
        externalOfferId: `feed:${row.externalProductId}`,
        name: row.name,
        priceCents: row.priceRupiah * 100,
        currency: "IDR",
        productUrl: row.productUrl,
        affiliateUrl: row.affiliateUrl,
        availability: "unknown" as const,
        ...(row.soldCount.value !== null ? { soldCount: row.soldCount.value } : {}),
        ...(row.commissionRateBps !== null ? { commissionRateBps: row.commissionRateBps } : {}),
        ...(row.commissionAmountRupiah !== null ? { commissionAmountCents: row.commissionAmountRupiah * 100 } : {}),
        metadata: { source: "shopee-affiliate-csv", moneyUnit: "IDR", shopName: row.shopName, salesSourceText: row.soldCount.sourceText, salesQuality: row.soldCount.quality }
      }))
    });
    return reply.status(201).send({ ...result, csv: { rowsParsed: parsed.rows.length, errors: [] } });
  }); app.get("/api/v1/marketplaces", async () => list(await services.marketplace.listConnections())); app.get("/api/v1/products", async () => list(await services.marketplace.listProducts())); app.patch("/api/v1/products/:productId/media", writeGuard, async (request) => { const { productId } = productMediaParamsSchema.parse(request.params); return services.marketplace.updateProductMedia(productId, updateProductMediaSchema.parse(request.body)); }); app.get("/api/v1/affiliate-offers", async () => list(await services.marketplace.listAffiliateOffers())); app.get("/api/v1/affiliate-offers/verification", async () => list(await services.marketplace.listAffiliateOfferVerification()));
  app.post("/api/v1/marketplaces", writeGuard, async (request, reply) => { const connection = await services.marketplace.createConnection(createMarketplaceConnectionSchema.parse(request.body)); request.log.info({ event: "marketplace_connection_created", connectionSlug: connection.slug, providerSlug: connection.providerSlug }); return reply.status(201).send(connection); }); app.get("/api/v1/marketplaces/:connectionSlug", async (request) => services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug)); app.patch("/api/v1/marketplaces/:connectionSlug", writeGuard, async (request) => { const connection = await services.marketplace.updateConnection(marketplaceSlugSchema.parse(request.params).connectionSlug, updateMarketplaceConnectionSchema.parse(request.body)); request.log.info({ event: "marketplace_connection_updated", connectionSlug: connection.slug, providerSlug: connection.providerSlug }); return connection; }); app.put("/api/v1/marketplaces/:connectionSlug/enabled", writeGuard, async (request, reply) => { const input = marketplaceEnableSchema.parse(request.body); const connection = await services.marketplace.setEnabled(marketplaceSlugSchema.parse(request.params).connectionSlug, input.enabled, "confirmation" in input ? input.confirmation : undefined); auditSecurityEvent(request.log, request, "marketplace_connection_enabled_changed", { connectionSlug: connection.slug, enabled: connection.enabled }); return connection; }); app.put("/api/v1/marketplaces/:connectionSlug/affiliate-account", writeGuard, async (request) => services.marketplace.bindAffiliateAccount(marketplaceSlugSchema.parse(request.params).connectionSlug, bindAffiliateAccountSchema.parse(request.body).affiliateId)); app.post("/api/v1/marketplaces/:connectionSlug/conversions/sync", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); const { since } = marketplaceConversionSyncSchema.parse(request.body); return services.shopeeConversionSync.sync(connectionSlug, since); }); app.post("/api/v1/marketplaces/:connectionSlug/reports/shopee/commission/reconcile", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); return services.shopeeCommissionReportReconciliation.reconcile(connectionSlug, shopeeCommissionReportSchema.parse(request.body)); }); app.post("/api/v1/marketplaces/:connectionSlug/test", writeGuard, async (request) => { const connection = await services.marketplace.testConnection(marketplaceSlugSchema.parse(request.params).connectionSlug); request.log.info({ event: "marketplace_connection_tested", connectionSlug: connection.slug, healthStatus: connection.healthStatus }); return connection; }); app.get("/api/v1/marketplaces/:connectionSlug/health", async (request) => { const connection = await services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug); return { status: connection.healthStatus, error: connection.healthStatus === "unhealthy" ? "Marketplace connection is unhealthy." : undefined, lastCheckedAt: connection.lastCheckedAt, lastSuccessfulCheckAt: connection.lastSuccessfulCheckAt, lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }; }); app.post("/api/v1/marketplaces/:connectionSlug/products/discover", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); return list(await services.marketplace.discoverProducts(connectionSlug)); }); app.get("/api/v1/marketplaces/:connectionSlug/products/search", async (request) => { const { connectionSlug, query } = marketplaceSearchSchema.parse({ ...(request.params as object), ...(request.query as object) }); return list(await services.marketplace.searchProducts(connectionSlug, query)); }); app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId", async (request) => { const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params); return services.marketplace.getProduct(connectionSlug, externalProductId); }); app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers", async (request) => { const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params); return list(await services.marketplace.getOffers(connectionSlug, externalProductId)); }); app.post("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers/:externalOfferId/affiliate-link", writeGuard, async (request) => { const input = marketplaceLinkSchema.parse(request.params); return services.marketplace.generateAffiliateLink(input.connectionSlug, input.externalProductId, input.externalOfferId); });
  app.get("/api/v1/campaigns", async () => list(await services.campaigns.list())); app.post("/api/v1/campaigns", writeGuard, async (request, reply) => reply.status(201).send(await services.campaigns.create(createCampaignSchema.parse(request.body)))); app.get("/api/v1/campaigns/:campaignId", async (request) => services.campaigns.get(campaignIdSchema.parse(request.params).campaignId)); app.patch("/api/v1/campaigns/:campaignId", writeGuard, async (request) => services.campaigns.update(campaignIdSchema.parse(request.params).campaignId, updateCampaignSchema.parse(request.body))); app.get("/api/v1/campaigns/:campaignId/offers", async (request) => list(await services.campaigns.listOffers(campaignIdSchema.parse(request.params).campaignId))); app.post("/api/v1/campaigns/:campaignId/offers/:affiliateOfferId", writeGuard, async (request, reply) => { const params = campaignOfferParamsSchema.parse(request.params); return reply.status(201).send(await services.campaigns.attachOffer(params.campaignId, params.affiliateOfferId)); }); app.delete("/api/v1/campaigns/:campaignId/offers/:affiliateOfferId", writeGuard, async (request) => { const params = campaignOfferParamsSchema.parse(request.params); await services.campaigns.removeOffer(params.campaignId, params.affiliateOfferId); return { status: "removed" }; });
  app.get("/api/v1/tracking-links", async (request) => { const { campaignId } = trackingLinkQuerySchema.parse(request.query); return list(await services.tracking.list(campaignId)); }); app.post("/api/v1/tracking-links", writeGuard, async (request, reply) => reply.status(201).send(await services.tracking.create(createTrackingLinkSchema.parse(request.body)))); app.get("/api/v1/tracking-links/:trackingLinkId", async (request) => services.tracking.get(trackingLinkIdSchema.parse(request.params).trackingLinkId)); app.post("/api/v1/tracking-links/:trackingLinkId/clicks", writeGuard, async (request) => services.tracking.recordClick(trackingLinkIdSchema.parse(request.params).trackingLinkId, recordClickSchema.parse(request.body))); app.get("/api/v1/tracking-links/:trackingLinkId/stats", async (request) => services.tracking.stats(trackingLinkIdSchema.parse(request.params).trackingLinkId));
  app.get("/api/v1/analytics/overview", async () => services.analytics.overview()); app.get("/api/v1/autonomous/performance-index", writeGuard, async () => ({ data: buildPerformanceIndex(await services.analytics.overview()) })); app.get("/api/v1/analytics/campaigns/:campaignId", async (request) => services.analytics.campaign(campaignIdSchema.parse(request.params).campaignId)); app.get("/api/v1/content", async (request) => { const { campaignId } = contentQuerySchema.parse(request.query); return list(await services.content.list(campaignId)); }); app.post("/api/v1/content", writeGuard, async (request, reply) => reply.status(201).send(await services.content.create(createContentSchema.parse(request.body)))); app.post("/api/v1/content/:contentId/product-media", writeGuard, async (request) => { const { contentId } = contentIdSchema.parse(request.params); const { kinds } = attachProductMediaSchema.parse(request.body); return services.content.attachProductMedia(contentId, kinds); }); app.get("/api/v1/content/:contentId", async (request) => services.content.get(contentIdSchema.parse(request.params).contentId)); app.get("/api/v1/content/:contentId/story", async (request) => services.contentStory.get(contentIdSchema.parse(request.params).contentId)); app.put("/api/v1/content/:contentId/story/products", writeGuard, async (request) => services.contentStory.replaceProducts(contentIdSchema.parse(request.params).contentId, contentStoryProductsSchema.parse(request.body).products)); app.patch("/api/v1/content/:contentId", writeGuard, async (request) => services.content.update(contentIdSchema.parse(request.params).contentId, updateContentSchema.parse(request.body)));
  app.get("/api/v1/social-accounts", writeGuard, async () => list(await services.socialAccounts.list())); app.post("/api/v1/social-accounts", writeGuard, async (request, reply) => reply.status(201).send(await services.socialAccounts.create(createSocialAccountSchema.parse(request.body)))); app.get("/api/v1/social-accounts/:socialAccountId", writeGuard, async (request) => services.socialAccounts.get(socialAccountIdSchema.parse(request.params).socialAccountId)); app.patch("/api/v1/social-accounts/:socialAccountId", writeGuard, async (request) => services.socialAccounts.update(socialAccountIdSchema.parse(request.params).socialAccountId, updateSocialAccountSchema.parse(request.body)));
  app.post("/api/v1/social-accounts/:socialAccountId/credential/rotate", writeGuard, async (request) => { const { socialAccountId } = socialAccountIdSchema.parse(request.params); const { credentialReference } = socialCredentialRotationSchema.parse(request.body); const account = await services.socialAccounts.rotateCredential(socialAccountId, credentialReference); auditSecurityEvent(request.log, request, "social_credential_rotated", { socialAccountId }); return account; });
  app.post("/api/v1/social-accounts/:socialAccountId/credential/revoke", writeGuard, async (request) => { const { socialAccountId } = socialAccountIdSchema.parse(request.params); const account = await services.socialAccounts.revokeCredential(socialAccountId); auditSecurityEvent(request.log, request, "social_credential_revoked", { socialAccountId }); return account; });
  app.post("/api/v1/social-accounts/oauth/start", writeGuard, async (request) => { const input = socialOAuthStartSchema.parse(request.body); return services.socialOAuth.start(input.platform, input.redirectUri); }); app.get("/api/v1/social-accounts/oauth/callback", async (request) => { const input = socialOAuthCallbackSchema.parse(request.query); const platform = input.state.slice(37); return services.socialOAuth.callback(platform, input.code, input.state); });
}
