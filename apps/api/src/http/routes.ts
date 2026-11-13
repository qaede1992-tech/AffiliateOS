import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Affiliate, Commission, Conversion, CreateAffiliateRequest, CreateConversionRequest, CreateOfferRequest, ListResponse, Offer, Product, ProductOpportunity } from "@affiliateos/shared";
import type { Services } from "../domain/container.js";
import type { PublicShopCatalogItem } from "../domain/repository.js";
import type { ProviderEventStore } from "../db/provider-events.js";
import { captureRawBody, getRawBody } from "./raw-body.js";
import { createAffiliateSchema, affiliateOfferVerificationQuerySchema, createConversionSchema, createOfferSchema, scoreProductSchema, conversionIdSchema, createConversionAttributionSchema, marketplaceLinkSchema, marketplaceProductParamsSchema, marketplaceSearchSchema, marketplaceSlugSchema, marketplaceConversionSyncSchema, createMarketplaceConnectionSchema, marketplaceEnableSchema, bindAffiliateAccountSchema, updateMarketplaceConnectionSchema, createCampaignSchema, updateCampaignSchema, campaignIdSchema, campaignOfferParamsSchema, autonomousRunIdSchema, autonomousRunQuerySchema, autonomousDecisionAuditQuerySchema, trackingLinkQuerySchema, createTrackingLinkSchema, trackingLinkIdSchema, recordClickSchema, contentQuerySchema, contentIdSchema, contentStoryProductsSchema, attachProductMediaSchema, createContentSchema, updateContentSchema, scheduleContentSchema, socialAccountIdSchema, createSocialAccountSchema, updateSocialAccountSchema, socialCredentialRotationSchema, socialOAuthStartSchema, socialOAuthCallbackSchema, publicationJobIdSchema, tiktokPublicationApprovalSchema, importShopeeAffiliateFeedSchema, importShopeeAffiliateCsvSchema, productMediaParamsSchema, updateProductMediaSchema, productMediaRightsParamsSchema, updateProductMediaRightsSchema, productMediaCandidateListQuerySchema, productMediaCandidateReviewParamsSchema, reviewProductMediaCandidateSchema, shopeeCommissionReportSchema, publicShopQuerySchema, createShopeeAffiliateLinkIntakeSchema, shopeeAffiliateLinkIntakeParamsSchema } from "./validation.js";
import { ProductOpportunityService } from "../domain/foundations.js";
import { auditSecurityEvent } from "./app-audit.js";
import { ProductMediaCandidateImportError } from "../domain/product-media-candidate-import.js";
import { requireAdmin, requireOperator } from "./auth.js";
import { buildPerformanceIndex } from "../domain/performance-index.js";
import { determineAutonomousHealthStatus } from "../domain/autonomous-health-status.js";
import { TikTokProviderRequestError } from "../domain/tiktok-content-posting-client.js";
import { parseShopeeAffiliateCsv } from "../domain/shopee-affiliate-csv.js";
import { Readable } from "node:stream";
import { evaluateProductMediaAssetReadiness } from "../domain/media-readiness-evaluator.js";
import { hasCurrentVerifiedRights } from "../domain/product-media-publication-rights.js";
const list = <T>(data: T[]): ListResponse<T> => ({ data });
const toPublicHttpsMediaUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const isLocalHostname =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".test") ||
      hostname.endsWith(".invalid") ||
      hostname.endsWith(".example") ||
      hostname.endsWith(".onion") ||
      hostname.endsWith(".arpa") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home.arpa");
    return parsed.protocol === "https:" &&
      hostname.includes(".") &&
      !isIP(hostname) &&
      !isLocalHostname &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};
const writeGuard = { preHandler: requireOperator };
const adminGuard = { preHandler: requireAdmin };
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
  app.post("/api/v1/publication-jobs/:jobId/confirm", writeGuard, async (request) => { const { jobId } = publicationJobIdSchema.parse(request.params); const approval = tiktokPublicationApprovalSchema.parse(request.body); const job = await services.publicationJobs.confirmWithApproval(jobId, approval); void services.publicationScheduler.trigger(); auditSecurityEvent(request.log, request, "publication_job_confirmed", { jobId, privacyLevel: approval.privacyLevel, commercialDisclosureEnabled: approval.commercialDisclosureEnabled }); return job; });
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
    const status = determineAutonomousHealthStatus({
      schedulerRunning: scheduler.running,
      schedulerLastError: scheduler.lastError,
      publisherStatuses: publishers.map((publisher) => publisher.status),
      recoverableRunCount: recoverable.length
    });
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
  app.get<{ Reply: ListResponse<Commission> }>("/api/v1/commissions", async () => list(await services.commissions.list())); app.post("/api/v1/product-opportunities/score", writeGuard, async (request) => {
    const input = scoreProductSchema.parse(request.body);
    const assets = services.productMediaAssets
      ? (await services.productMediaAssets.listByProduct(input.product.id)).filter(hasCurrentVerifiedRights)
      : [];
    const platformScores = (["instagram", "tiktok"] as const).map((platform) => {
      if (assets.length === 0) return 0;
      return Math.max(...assets.map((asset) => {
        const readiness = evaluateProductMediaAssetReadiness(platform, asset);
        if (readiness.checks.length === 0) return 0;
        const points = readiness.checks.reduce((sum, item) =>
          sum + (item.status === "pass" ? 1 : item.status === "unknown" ? 0.35 : 0), 0);
        return (points / readiness.checks.length) * 100;
      }));
    });
    const mediaReadinessScore = platformScores.reduce((sum, score) => sum + score, 0) / platformScores.length;
    return new ProductOpportunityService().score(input.product, input.commissionRateBps, input.audienceRelevance, mediaReadinessScore);
  });
  app.post("/api/v1/shopee/affiliate-link-intakes", writeGuard, async (request, reply) => {
    const { affiliateUrl } = createShopeeAffiliateLinkIntakeSchema.parse(request.body);
    const intake = await services.shopeeAffiliateLinkIntakes.submit(affiliateUrl);
    auditSecurityEvent(request.log, request, "shopee_affiliate_link_intake_submitted", { intakeId: intake.id, status: intake.status });
    return reply.status(201).send(intake);
  });
  app.get("/api/v1/shopee/affiliate-link-intakes/:intakeId", writeGuard, async (request, reply) => {
    const { intakeId } = shopeeAffiliateLinkIntakeParamsSchema.parse(request.params);
    const intake = await services.shopeeAffiliateLinkIntakes.get(intakeId);
    if (!intake) return reply.status(404).send({ error: "NOT_FOUND", message: "Shopee affiliate link intake tidak ditemukan." });
    return intake;
  });
  app.get("/api/v1/marketplaces/providers", async () => list(await services.marketplace.listProviders())); app.post("/api/v1/marketplaces/shopee-affiliate-feed/import", writeGuard, async (request, reply) => {
    const input = importShopeeAffiliateFeedSchema.parse(request.body);
    const result = await services.marketplace.importShopeeAffiliateFeed(input);
    try {
      for (const item of input.items) await services.shopeeAffiliateLinkIntakes.reconcileVerifiedOffer(item.productUrl);
    } finally {
      if (result.importedProducts > 0 && result.importedOffers > 0) void services.autonomousScheduler.trigger();
    }
    return reply.status(201).send(result);
  }); app.post("/api/v1/marketplaces/shopee-affiliate-feed/import-csv", writeGuard, async (request, reply) => {
    const input = importShopeeAffiliateCsvSchema.parse(request.body);
    let parsed;
    try { parsed = parseShopeeAffiliateCsv(input.csv); }
    catch (error) { return reply.status(400).send({ error: "INVALID_SHOPEE_AFFILIATE_CSV", message: error instanceof Error ? error.message : "CSV Shopee tidak valid." }); }
    if (parsed.errors.length > 0 || parsed.rows.length === 0) return reply.status(400).send({ error: "INVALID_SHOPEE_AFFILIATE_CSV", message: "CSV berisi baris yang tidak valid; tidak ada data yang diimpor.", errors: parsed.errors, validRows: parsed.rows.length });
    if (parsed.rows.some((row) => row.commissionRateBps === null && row.commissionAmountRupiah === null)) return reply.status(400).send({ error: "MISSING_VERIFIED_COMMISSION", message: "CSV harus memuat komisi yang terverifikasi untuk setiap produk; tidak ada data yang diimpor." });
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
        ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
        ...(row.videoUrl ? { videoUrl: row.videoUrl } : {}),
        availability: "unknown" as const,
        ...(row.soldCount.value !== null ? { soldCount: row.soldCount.value } : {}),
        ...(row.reviewCount.value !== null ? { reviewCount: row.reviewCount.value } : {}),
        ...(row.ratingMilli !== undefined ? { ratingMilli: row.ratingMilli } : {}),
        ...(row.commissionRateBps !== null ? { commissionRateBps: row.commissionRateBps } : {}),
        ...(row.commissionAmountRupiah !== null ? { commissionAmountCents: row.commissionAmountRupiah * 100 } : {}),
        metadata: {
          source: "shopee-affiliate-csv",
          moneyUnit: "IDR",
          shopName: row.shopName,
          salesSourceText: row.soldCount.sourceText,
          salesQuality: row.soldCount.quality,
          dataQuality: {
            soldCount: row.soldCount.quality,
            reviewCount: row.reviewCount.quality,
            ratingMilli: row.ratingMilli !== undefined ? "exact" : "missing",
            source: "shopee-affiliate-csv"
          }
        }
      }))
    });
    try {
      for (const row of parsed.rows) await services.shopeeAffiliateLinkIntakes.reconcileVerifiedOffer(row.productUrl);
    } finally {
      if (result.importedProducts > 0 && result.importedOffers > 0) void services.autonomousScheduler.trigger();
    }
    return reply.status(201).send({ ...result, csv: { rowsParsed: parsed.rows.length, errors: [] } });
  }); app.get("/api/v1/marketplaces", async () => list(await services.marketplace.listConnections())); app.get<{ Querystring: { query?: string; page?: string | number; pageSize?: string | number } }>("/api/v1/public/shop", async (request, reply) => {
    const query = publicShopQuerySchema.parse(request.query);
    let catalog: { data: PublicShopCatalogItem[]; total: number; page: number; pageSize: number };
    if (services.publicShopCatalog) {
      catalog = await services.publicShopCatalog.listPage(query);
    } else if (services.publicShopCatalogFallbackAllowed === true) {
      const [products, offers, trackingLinks] = await Promise.all([
        services.marketplace.listProducts(),
        services.marketplace.listAffiliateOffers(),
        services.tracking.list()
      ]);
      const productsById = new Map(products.map((product) => [product.id, product]));
      const seen = new Set<string>();
      const normalized = query.query.toLocaleLowerCase("id-ID");
      const numericQuery = /^\d+$/.test(normalized);
      const numericValue = numericQuery ? Number(normalized) : Number.NaN;
      const numeric = Number.isSafeInteger(numericValue) ? numericValue : null;
      const items: PublicShopCatalogItem[] = offers.flatMap((offer) => {
        if (offer.status !== "active" || offer.affiliateLinkStatus !== "active" || !offer.affiliateUrl) return [];
        if (offer.affiliateLinkExpiresAt && Date.parse(offer.affiliateLinkExpiresAt) <= Date.now()) return [];
        const product = productsById.get(offer.productId);
        const trackingLink = trackingLinks.find((link) =>
          link.affiliateOfferId === offer.id &&
          link.status === "active" &&
          link.destinationUrl === offer.affiliateUrl
        );
        if (!product || product.status !== "active" || !trackingLink || seen.has(product.id)) return [];
        if (normalized && (numericQuery
          ? numeric === null || product.referenceNumber !== numeric
          : !product.name.toLocaleLowerCase("id-ID").includes(normalized))) return [];
        seen.add(product.id);
        return [{
          id: product.id,
          referenceNumber: product.referenceNumber ?? null,
          name: product.name,
          category: product.category ?? null,
          priceCents: offer.priceCents ?? product.priceCents,
          currency: offer.currency ?? product.currency,
          ratingMilli: product.ratingMilli ?? null,
          reviewCount: product.reviewCount ?? null,
          trackingCode: trackingLink.code,
          imageUrl: product.imageUrl,
          videoUrl: product.videoUrl
        }];
      }).sort((left, right) => (left.referenceNumber ?? Number.MAX_SAFE_INTEGER) - (right.referenceNumber ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
      const offset = (query.page - 1) * query.pageSize;
      catalog = {
        data: items.slice(offset, offset + query.pageSize),
        total: items.length,
        page: query.page,
        pageSize: query.pageSize
      };
    } else {
      return reply.status(503).send({
        error: "PUBLIC_SHOP_CATALOG_UNAVAILABLE",
        message: "The product catalog is temporarily unavailable."
      });
    }

    const productsWithMedia = catalog.data.filter((product) => Boolean(product.imageUrl || product.videoUrl));
    const mediaRepository = services.productMediaAssets;
    const mediaAssets = mediaRepository && typeof mediaRepository.listByProducts === "function" && productsWithMedia.length > 0
      ? await mediaRepository.listByProducts(productsWithMedia.map((product) => product.id))
      : [];
    const getVerifiedMediaUrl = (product: PublicShopCatalogItem, kind: "image" | "video"): string | undefined => {
      const rawUrl = kind === "image" ? product.imageUrl : product.videoUrl;
      const safeUrl = toPublicHttpsMediaUrl(rawUrl ?? undefined);
      if (!safeUrl) return undefined;
      const matchingAssets = mediaAssets.filter((asset) =>
        asset.productId === product.id && asset.sourceUrl === rawUrl
      );
      if (matchingAssets.length !== 1) return undefined;
      const asset = matchingAssets[0];
      if (!asset || asset.kind !== kind || !hasCurrentVerifiedRights(asset)) return undefined;
      if (asset.identityStatus !== "not_required" && asset.identityStatus !== "verified") return undefined;
      return safeUrl;
    };
    return {
      ...catalog,
      data: catalog.data.map((product) => ({
        ...product,
        imageUrl: getVerifiedMediaUrl(product, "image"),
        videoUrl: getVerifiedMediaUrl(product, "video")
      }))
    };
  });
  app.get("/api/v1/products", async () => list(await services.marketplace.listProducts())); app.patch("/api/v1/products/:productId/media", writeGuard, async (request) => {
    const { productId } = productMediaParamsSchema.parse(request.params);
    const input = updateProductMediaSchema.parse(request.body);
    const product = await services.marketplace.updateProductMedia(productId, input);
    if (input.imageUrl || input.videoUrl) void services.autonomousScheduler.trigger();
    return product;
  });
  app.get("/api/v1/products/:productId/media-candidates", adminGuard, async (request, reply) => {
    const { productId } = productMediaParamsSchema.parse(request.params);
    const query = productMediaCandidateListQuerySchema.parse(request.query);
    const repository = services.productMediaCandidates;
    if (!repository) return reply.status(503).send({ error: "PRODUCT_MEDIA_CANDIDATES_UNAVAILABLE", message: "Product media candidate storage is not configured." });
    if (!query.status || query.status === "pending") return list(await repository.listPendingByProduct(productId, 50));
    if (!repository.listByProductAndReviewStatus) return reply.status(503).send({ error: "PRODUCT_MEDIA_CANDIDATE_STATUS_QUERY_UNAVAILABLE", message: "Reviewed candidate listing is not configured." });
    return list(await repository.listByProductAndReviewStatus(productId, query.status, 50));
  });
  app.patch("/api/v1/products/:productId/media-candidates/:candidateId/review", adminGuard, async (request, reply) => {
    const { productId, candidateId } = productMediaCandidateReviewParamsSchema.parse(request.params);
    const input = reviewProductMediaCandidateSchema.parse(request.body);
    const repository = services.productMediaCandidates;
    if (!repository?.review) return reply.status(503).send({ error: "PRODUCT_MEDIA_CANDIDATE_REVIEW_UNAVAILABLE", message: "Atomic candidate review and audit storage are not configured." });
    const actorId = request.auth?.operatorId;
    if (!actorId) return reply.status(403).send({ error: "FORBIDDEN", message: "An authenticated administrator is required." });
    const updated = await repository.review(candidateId, productId, { ...input, actorId, actorRole: "admin" });
    if (!updated) return reply.status(409).send({ error: "PRODUCT_MEDIA_CANDIDATE_NOT_PENDING", message: "The candidate does not exist for this product or has already been reviewed." });
    auditSecurityEvent(request.log, request, "product_media_candidate_reviewed", { productId, candidateId, status: updated.reviewStatus });
    return updated;
  });
  app.post("/api/v1/products/:productId/media-candidates/:candidateId/import", adminGuard, async (request, reply) => {
    const { productId, candidateId } = productMediaCandidateReviewParamsSchema.parse(request.params);
    const importer = services.productMediaCandidateImport;
    if (!importer) return reply.status(503).send({ error: "PRODUCT_MEDIA_CANDIDATE_IMPORT_UNAVAILABLE", message: "Candidate import requires configured media storage, repositories, and autonomous selection audit." });
    const actorId = request.auth?.operatorId;
    if (!actorId) return reply.status(403).send({ error: "FORBIDDEN", message: "An authenticated administrator is required." });
    try {
      const result = await importer.importApprovedCandidate(productId, candidateId);
      auditSecurityEvent(request.log, request, "product_media_candidate_imported", {
        productId, candidateId, assetId: result.asset.id, alreadyImported: result.alreadyImported,
        rightsStatus: result.asset.rightsStatus
      });
      return reply.status(result.alreadyImported ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof ProductMediaCandidateImportError) {
        return reply.status(error.statusCode).send({ error: error.code, message: error.message });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "product media candidate import failed");
      return reply.status(502).send({ error: "PRODUCT_MEDIA_CANDIDATE_IMPORT_FAILED", message: "The approved media candidate could not be imported." });
    }
  });
  app.get("/api/v1/products/:productId/media-candidates/:candidateId/review-audits", adminGuard, async (request, reply) => {
    const { productId, candidateId } = productMediaCandidateReviewParamsSchema.parse(request.params);
    const repository = services.productMediaCandidates;
    if (!repository?.listReviewAudits) return reply.status(503).send({ error: "PRODUCT_MEDIA_CANDIDATE_AUDIT_UNAVAILABLE", message: "Candidate review audit storage is not configured." });
    return list(await repository.listReviewAudits(productId, candidateId));
  });
  app.get("/api/v1/products/:productId/media-assets", adminGuard, async (request, reply) => {
    const { productId } = productMediaParamsSchema.parse(request.params);
    if (!services.productMediaAssets) return reply.status(503).send({ error: "PRODUCT_MEDIA_RIGHTS_UNAVAILABLE", message: "Product media rights storage is not configured." });
    let tiktokMaxVideoPostDurationSec: number | undefined;
    try {
      const tiktokAccounts = (await services.socialAccounts.list()).filter(
        (account) => account.platform === "tiktok" && account.status === "active"
      );
      if (tiktokAccounts.length === 1) {
        const account = await services.socialAccounts.getForPublisher(tiktokAccounts[0]!.id);
        const creatorInfo = await services.tiktokCreatorInfo.getCreatorInfo(account);
        if (typeof creatorInfo.maxVideoPostDurationSec === "number" &&
          Number.isFinite(creatorInfo.maxVideoPostDurationSec) && creatorInfo.maxVideoPostDurationSec > 0) {
          tiktokMaxVideoPostDurationSec = creatorInfo.maxVideoPostDurationSec;
        }
      }
    } catch {
      // Keep the technical preflight available during provider outages; duration remains unknown.
    }
    const assets = await services.productMediaAssets.listByProduct(productId);
    return list(assets.map((asset) => ({
      ...asset,
      technicalReadiness: {
        instagram: evaluateProductMediaAssetReadiness("instagram", asset),
        tiktok: evaluateProductMediaAssetReadiness("tiktok", asset, {
          ...(tiktokMaxVideoPostDurationSec === undefined ? {} : { tiktokMaxVideoPostDurationSec })
        })
      }
    })));
  });
  app.get("/api/v1/products/:productId/media-assets/:assetId/preview", adminGuard, async (request, reply) => {
    const { productId, assetId } = productMediaRightsParamsSchema.parse(request.params);
    const createPreviewUrl = services.productMediaPreviewUrl;
    if (!createPreviewUrl) return reply.status(503).send({ error: "PRODUCT_MEDIA_PREVIEW_UNAVAILABLE", message: "Private product media preview is not configured." });
    const previewUrl = await createPreviewUrl(productId, assetId);
    if (!previewUrl) return reply.status(404).send({ error: "PRODUCT_MEDIA_ASSET_NOT_FOUND", message: "Product media asset was not found." });
    return { url: previewUrl, expiresInSeconds: 300 };
  });
  app.get("/api/v1/products/:productId/media-assets/:assetId/rights-audits", adminGuard, async (request, reply) => {
    const { productId, assetId } = productMediaRightsParamsSchema.parse(request.params);
    const repository = services.productMediaAssets;
    if (!repository?.listRightsAudits) return reply.status(503).send({ error: "PRODUCT_MEDIA_RIGHTS_AUDIT_UNAVAILABLE", message: "Product media rights audit history is not configured." });
    const asset = (await repository.listByProduct(productId)).find((item) => item.id === assetId);
    if (!asset) return reply.status(404).send({ error: "PRODUCT_MEDIA_ASSET_NOT_FOUND", message: "Product media asset was not found." });
    return list(await repository.listRightsAudits(productId, assetId));
  });
  app.patch("/api/v1/products/:productId/media-assets/:assetId/rights", adminGuard, async (request, reply) => {
    const { productId, assetId } = productMediaRightsParamsSchema.parse(request.params);
    const input = updateProductMediaRightsSchema.parse(request.body);
    const repository = services.productMediaAssets;
    const reviewRights = repository?.reviewRights;
    if (!repository || !reviewRights) return reply.status(503).send({ error: "PRODUCT_MEDIA_RIGHTS_UNAVAILABLE", message: "Atomic product media rights review and audit storage are not configured." });
    const actorId = request.auth?.operatorId;
    if (!actorId) return reply.status(403).send({ error: "FORBIDDEN", message: "An authenticated administrator is required." });
    const updated = await reviewRights.call(repository, assetId, productId, {
      ...input,
      actorId,
      actorRole: "admin"
    });
    if (!updated) return reply.status(404).send({ error: "PRODUCT_MEDIA_ASSET_NOT_FOUND", message: "Product media asset was not found." });
    auditSecurityEvent(request.log, request, "product_media_rights_updated", { productId, assetId, status: updated.rightsStatus, rightsBasis: updated.rightsBasis ?? undefined });
    if (input.status === "verified" && updated.rightsStatus === "verified") void services.autonomousScheduler.trigger();
    return updated;
  }); app.get("/api/v1/affiliate-offers", async () => list(await services.marketplace.listAffiliateOffers())); app.get("/api/v1/affiliate-offers/verification", async (request) => { const input = affiliateOfferVerificationQuerySchema.parse(request.query); const result = await services.marketplace.listAffiliateOfferVerification(input); return { ...list(result.items), nextCursor: result.nextCursor, hasMore: result.hasMore }; });
  app.post("/api/v1/marketplaces", writeGuard, async (request, reply) => { const connection = await services.marketplace.createConnection(createMarketplaceConnectionSchema.parse(request.body)); request.log.info({ event: "marketplace_connection_created", connectionSlug: connection.slug, providerSlug: connection.providerSlug }); return reply.status(201).send(connection); }); app.get("/api/v1/marketplaces/:connectionSlug", async (request) => services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug)); app.patch("/api/v1/marketplaces/:connectionSlug", writeGuard, async (request) => { const connection = await services.marketplace.updateConnection(marketplaceSlugSchema.parse(request.params).connectionSlug, updateMarketplaceConnectionSchema.parse(request.body)); request.log.info({ event: "marketplace_connection_updated", connectionSlug: connection.slug, providerSlug: connection.providerSlug }); return connection; }); app.put("/api/v1/marketplaces/:connectionSlug/enabled", writeGuard, async (request, reply) => { const input = marketplaceEnableSchema.parse(request.body); const connection = await services.marketplace.setEnabled(marketplaceSlugSchema.parse(request.params).connectionSlug, input.enabled, "confirmation" in input ? input.confirmation : undefined); auditSecurityEvent(request.log, request, "marketplace_connection_enabled_changed", { connectionSlug: connection.slug, enabled: connection.enabled }); if (connection.enabled && connection.status === "active") void services.autonomousScheduler.trigger(); return connection; }); app.put("/api/v1/marketplaces/:connectionSlug/affiliate-account", writeGuard, async (request) => { const account = await services.marketplace.bindAffiliateAccount(marketplaceSlugSchema.parse(request.params).connectionSlug, bindAffiliateAccountSchema.parse(request.body).affiliateId); void services.autonomousScheduler.trigger(); return account; }); app.post("/api/v1/marketplaces/:connectionSlug/conversions/sync", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); const { since } = marketplaceConversionSyncSchema.parse(request.body); return services.shopeeConversionSync.sync(connectionSlug, since); }); app.post("/api/v1/marketplaces/:connectionSlug/reports/shopee/commission/reconcile", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); return services.shopeeCommissionReportReconciliation.reconcile(connectionSlug, shopeeCommissionReportSchema.parse(request.body)); }); app.post("/api/v1/marketplaces/:connectionSlug/test", writeGuard, async (request) => { const connection = await services.marketplace.testConnection(marketplaceSlugSchema.parse(request.params).connectionSlug); request.log.info({ event: "marketplace_connection_tested", connectionSlug: connection.slug, healthStatus: connection.healthStatus }); return connection; }); app.get("/api/v1/marketplaces/:connectionSlug/health", async (request) => { const connection = await services.marketplace.getConnection(marketplaceSlugSchema.parse(request.params).connectionSlug); return { status: connection.healthStatus, error: connection.healthStatus === "unhealthy" ? "Marketplace connection is unhealthy." : undefined, lastCheckedAt: connection.lastCheckedAt, lastSuccessfulCheckAt: connection.lastSuccessfulCheckAt, lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }; }); app.post("/api/v1/marketplaces/:connectionSlug/products/discover", writeGuard, async (request) => { const { connectionSlug } = marketplaceSlugSchema.parse(request.params); return list(await services.marketplace.discoverProducts(connectionSlug)); }); app.get("/api/v1/marketplaces/:connectionSlug/products/search", async (request) => { const { connectionSlug, query } = marketplaceSearchSchema.parse({ ...(request.params as object), ...(request.query as object) }); return list(await services.marketplace.searchProducts(connectionSlug, query)); }); app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId", async (request) => { const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params); return services.marketplace.getProduct(connectionSlug, externalProductId); }); app.get("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers", async (request) => { const { connectionSlug, externalProductId } = marketplaceProductParamsSchema.parse(request.params); return list(await services.marketplace.getOffers(connectionSlug, externalProductId)); }); app.post("/api/v1/marketplaces/:connectionSlug/products/:externalProductId/offers/:externalOfferId/affiliate-link", writeGuard, async (request) => { const input = marketplaceLinkSchema.parse(request.params); const offer = await services.marketplace.generateAffiliateLink(input.connectionSlug, input.externalProductId, input.externalOfferId); if (offer.status === "active" && offer.affiliateLinkStatus === "active") void services.autonomousScheduler.trigger(); return offer; });
  app.get("/api/v1/campaigns", async () => list(await services.campaigns.list())); app.post("/api/v1/campaigns", writeGuard, async (request, reply) => reply.status(201).send(await services.campaigns.create(createCampaignSchema.parse(request.body)))); app.get("/api/v1/campaigns/:campaignId", async (request) => services.campaigns.get(campaignIdSchema.parse(request.params).campaignId)); app.patch("/api/v1/campaigns/:campaignId", writeGuard, async (request) => services.campaigns.update(campaignIdSchema.parse(request.params).campaignId, updateCampaignSchema.parse(request.body))); app.get("/api/v1/campaigns/:campaignId/offers", async (request) => list(await services.campaigns.listOffers(campaignIdSchema.parse(request.params).campaignId))); app.post("/api/v1/campaigns/:campaignId/offers/:affiliateOfferId", writeGuard, async (request, reply) => { const params = campaignOfferParamsSchema.parse(request.params); return reply.status(201).send(await services.campaigns.attachOffer(params.campaignId, params.affiliateOfferId)); }); app.delete("/api/v1/campaigns/:campaignId/offers/:affiliateOfferId", writeGuard, async (request) => { const params = campaignOfferParamsSchema.parse(request.params); await services.campaigns.removeOffer(params.campaignId, params.affiliateOfferId); return { status: "removed" }; });
  app.get("/api/v1/tracking-links", async (request) => { const { campaignId } = trackingLinkQuerySchema.parse(request.query); return list(await services.tracking.list(campaignId)); }); app.post("/api/v1/tracking-links", writeGuard, async (request, reply) => reply.status(201).send(await services.tracking.create(createTrackingLinkSchema.parse(request.body)))); app.get("/api/v1/tracking-links/:trackingLinkId", async (request) => services.tracking.get(trackingLinkIdSchema.parse(request.params).trackingLinkId)); app.post("/api/v1/tracking-links/:trackingLinkId/clicks", writeGuard, async (request) => services.tracking.recordClick(trackingLinkIdSchema.parse(request.params).trackingLinkId, recordClickSchema.parse(request.body))); app.get("/api/v1/tracking-links/:trackingLinkId/stats", async (request) => services.tracking.stats(trackingLinkIdSchema.parse(request.params).trackingLinkId));
  app.get("/api/v1/analytics/overview", async () => services.analytics.overview()); app.get("/api/v1/autonomous/performance-index", writeGuard, async () => ({ data: buildPerformanceIndex(await services.analytics.overview()) })); app.get("/api/v1/analytics/campaigns/:campaignId", async (request) => services.analytics.campaign(campaignIdSchema.parse(request.params).campaignId)); app.get("/api/v1/content", async (request) => { const { campaignId } = contentQuerySchema.parse(request.query); return list(await services.content.list(campaignId)); }); app.post("/api/v1/content", writeGuard, async (request, reply) => reply.status(201).send(await services.content.create(createContentSchema.parse(request.body)))); app.post("/api/v1/content/:contentId/product-media", writeGuard, async (request) => { const { contentId } = contentIdSchema.parse(request.params); const { kinds } = attachProductMediaSchema.parse(request.body); return services.content.attachProductMedia(contentId, kinds); }); app.get("/api/v1/content/:contentId", async (request) => services.content.get(contentIdSchema.parse(request.params).contentId)); app.get("/api/v1/content/:contentId/story", async (request) => services.contentStory.get(contentIdSchema.parse(request.params).contentId)); app.put("/api/v1/content/:contentId/story/products", writeGuard, async (request) => services.contentStory.replaceProducts(contentIdSchema.parse(request.params).contentId, contentStoryProductsSchema.parse(request.body).products)); app.patch("/api/v1/content/:contentId", writeGuard, async (request) => services.content.update(contentIdSchema.parse(request.params).contentId, updateContentSchema.parse(request.body))); app.post("/api/v1/content/:contentId/schedule", writeGuard, async (request, reply) => { const { contentId } = contentIdSchema.parse(request.params); const input = scheduleContentSchema.parse(request.body); const content = await services.content.get(contentId); const supportedPublishers = services.distribution.listPublishers(content.platform).filter((publisher) => publisher.supportsContent?.(content) ?? true); if (supportedPublishers.length === 0) return reply.status(409).send({ error: "PUBLISHER_UNAVAILABLE", message: "No configured publisher supports this content format." }); const plan = await services.distribution.schedule({ content, scheduledAt: input.scheduledAt, ...(input.accountId ? { accountId: input.accountId } : {}) }); auditSecurityEvent(request.log, request, "content_scheduled_for_distribution", { contentId, platform: content.platform, socialAccountId: plan.account.id, publishable: plan.publishable }); return reply.status(202).send({ content: plan.content, account: { id: plan.account.id, platform: plan.account.platform, status: plan.account.status, accountReference: plan.account.accountReference }, scheduledAt: plan.scheduledAt, publishable: plan.publishable }); });
  app.get("/api/v1/social-accounts", writeGuard, async () => list(await services.socialAccounts.list())); app.post("/api/v1/social-accounts", writeGuard, async (request, reply) => reply.status(201).send(await services.socialAccounts.create(createSocialAccountSchema.parse(request.body)))); app.get("/api/v1/social-accounts/:socialAccountId", writeGuard, async (request) => services.socialAccounts.get(socialAccountIdSchema.parse(request.params).socialAccountId)); app.patch("/api/v1/social-accounts/:socialAccountId", writeGuard, async (request) => services.socialAccounts.update(socialAccountIdSchema.parse(request.params).socialAccountId, updateSocialAccountSchema.parse(request.body)));
  app.post("/api/v1/social-accounts/:socialAccountId/credential/rotate", writeGuard, async (request) => { const { socialAccountId } = socialAccountIdSchema.parse(request.params); const { credentialReference } = socialCredentialRotationSchema.parse(request.body); const account = await services.socialAccounts.rotateCredential(socialAccountId, credentialReference); auditSecurityEvent(request.log, request, "social_credential_rotated", { socialAccountId }); return account; });
  app.post("/api/v1/social-accounts/:socialAccountId/credential/revoke", writeGuard, async (request) => { const { socialAccountId } = socialAccountIdSchema.parse(request.params); const account = await services.socialAccounts.revokeCredential(socialAccountId); auditSecurityEvent(request.log, request, "social_credential_revoked", { socialAccountId }); return account; });
  app.post("/api/v1/social-accounts/oauth/start", writeGuard, async (request) => { const input = socialOAuthStartSchema.parse(request.body); return services.socialOAuth.start(input.platform, input.redirectUri); }); app.get("/api/v1/social-accounts/oauth/callback", async (request) => { const input = socialOAuthCallbackSchema.parse(request.query); const platform = input.state.slice(37); return services.socialOAuth.callback(platform, input.code, input.state); });
}
