import { sql } from "drizzle-orm";
import { createApp } from "./app.js";
import { environment } from "./config.js";
import { createServices } from "./domain/container.js";
import { createDatabasePersistence } from "./db/client.js";
import { assertMediaSchemaReady } from "./db/schema-readiness.js";
import { PostgresAutonomousCycleLock } from "./db/autonomous-cycle-lock.js";
import { DrizzleAnalyticsReader } from "./db/analytics.js";
import { DrizzleConversionAttributionRepository } from "./db/attribution.js";
import { DrizzleOAuthStateRepository } from "./db/oauth-state.js";
import { DrizzlePublicationOperationRepository } from "./db/publication-operation-repository.js";
import { DrizzleAutonomousRunRepository } from "./db/autonomous-run-repository.js";
import { DrizzleAutonomousFeedbackMemoryRepository } from "./db/autonomous-feedback-memory-repository.js";
import { ProviderEventWorker } from "./domain/provider-event-worker.js";
import { ProviderEventScheduler } from "./domain/provider-event-scheduler.js";
import { ProviderEventProcessor } from "./domain/provider-event-processor.js";
import { ShopeeIntakeRecoveryWorker } from "./domain/shopee-intake-recovery-worker.js";
import { ShopeeIntakeRecoveryScheduler } from "./domain/shopee-intake-recovery-scheduler.js";
import { ProviderEventConversionProcessor, StaticProviderEventConversionNormalizerRegistry } from "./domain/provider-event-conversion-processor.js";
import { GenericProviderConversionNormalizer } from "./domain/provider-conversion.js";
import { MarketplaceProviderRegistry, ShopeeAffiliateFeedProvider } from "./domain/foundations.js";
import { createShopeeAffiliateProvider } from "./domain/shopee-affiliate-runtime.js";
import { InMemorySocialOAuthProviderRegistry } from "./domain/oauth.js";
import { TikTokOAuthProvider } from "./domain/tiktok-oauth-provider.js";
import { InstagramOAuthProvider } from "./domain/instagram-oauth-provider.js";
import { createOfficialSocialPublishers, createOfficialTikTokContentPostingClient } from "./domain/social-publisher-runtime.js";
import { JsonSocialCredentialResolver } from "./domain/social-credentials.js";
import { EncryptedFileSocialCredentialStore } from "./domain/encrypted-file-social-credentials.js";
import { createSupabaseStorageClientFromEnv } from "./domain/supabase-storage.js";
import { LocalProductMediaStorage } from "./domain/local-product-media-storage.js";
import { authorizeProductMediaDelivery } from "./domain/product-media-delivery-authorization.js";
import { createProductMediaDeliveryToken } from "./domain/product-media-delivery-token.js";
import { createProductMediaPreviewToken } from "./domain/product-media-preview-token.js";
import { authorizeProductMediaPreview } from "./domain/product-media-preview-authorization.js";
import { ProductImageGenerationService } from "./domain/product-image-generation.js";
import { ProductIllustrativeImageGenerationService } from "./domain/product-illustrative-image-generation.js";
import { assertContentUnchangedSincePublicationOperation, assertProductMediaRightsForPublication, assertPublicationMediaIntegritySnapshot, createPublicationMediaIntegritySnapshot } from "./domain/product-media-publication-rights.js";
const safeErrorType = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";


const persistence = createDatabasePersistence(environment.DATABASE_URL);
const marketplaceRegistry = new MarketplaceProviderRegistry();
marketplaceRegistry.register(new ShopeeAffiliateFeedProvider());
const shopeeProvider = createShopeeAffiliateProvider({
  credentialReference: environment.SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE,
  market: environment.SHOPEE_AFFILIATE_MARKET,
  apiVersion: environment.SHOPEE_AFFILIATE_API_VERSION
});
if (shopeeProvider) marketplaceRegistry.register(shopeeProvider);
const autonomousCycleLock = new PostgresAutonomousCycleLock(persistence.pool);
const socialOAuthRegistry = new InMemorySocialOAuthProviderRegistry();
if (environment.TIKTOK_CLIENT_KEY && environment.TIKTOK_CLIENT_SECRET) socialOAuthRegistry.register(new TikTokOAuthProvider({ clientKey: environment.TIKTOK_CLIENT_KEY, clientSecret: environment.TIKTOK_CLIENT_SECRET }));
if (environment.INSTAGRAM_CLIENT_ID && environment.INSTAGRAM_CLIENT_SECRET) socialOAuthRegistry.register(new InstagramOAuthProvider({ clientId: environment.INSTAGRAM_CLIENT_ID, clientSecret: environment.INSTAGRAM_CLIENT_SECRET }));
const fileSocialCredentialStore = environment.SOCIAL_CREDENTIAL_STORE_KEY
  ? EncryptedFileSocialCredentialStore.fromSecret(
      environment.SOCIAL_CREDENTIAL_STORE_PATH,
      environment.SOCIAL_CREDENTIAL_STORE_KEY
    )
  : undefined;
const socialCredentialResolver = fileSocialCredentialStore
  ?? (environment.SOCIAL_CREDENTIALS_JSON
    ? JsonSocialCredentialResolver.fromJson(environment.SOCIAL_CREDENTIALS_JSON)
    : undefined);
const mediaStorage = createSupabaseStorageClientFromEnv({
  SUPABASE_URL: environment.SUPABASE_URL,
  SUPABASE_STORAGE_SERVICE_KEY: environment.SUPABASE_STORAGE_SERVICE_KEY,
  SUPABASE_MEDIA_BUCKET: environment.SUPABASE_MEDIA_BUCKET
});
const mediaBucket = environment.SUPABASE_MEDIA_BUCKET || "affiliate-media";
const localProductMediaStorage = environment.PRODUCT_MEDIA_STORAGE_PATH && environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY && environment.PRODUCT_MEDIA_PUBLIC_BASE_URL
  ? new LocalProductMediaStorage({
      rootDirectory: environment.PRODUCT_MEDIA_STORAGE_PATH,
      maxImageBytes: 10 * 1024 * 1024,
      maxVideoBytes: 45 * 1024 * 1024
    })
  : undefined;
const services = createServices(
  persistence.repositories,
  persistence.transactionManager,
  marketplaceRegistry,
  socialOAuthRegistry,
  new DrizzleOAuthStateRepository(persistence.db),
  new DrizzleAnalyticsReader(persistence.db),
  new DrizzleConversionAttributionRepository(persistence.db),
  createOfficialSocialPublishers({
    credentialResolver: socialCredentialResolver,
    instagram: {
      mediaUrlResolver: async (asset) => {
        if (asset.source === "url") return asset.reference;
        if (!mediaStorage) throw new Error("Supabase Storage is not configured for Instagram media.");
        const separator = asset.reference.indexOf("/");
        if (separator <= 0 || asset.reference.slice(0, separator) !== mediaBucket) {
          throw new Error("Instagram media asset references an unexpected Storage bucket.");
        }
        const key = asset.reference.slice(separator + 1);
        if (!key) throw new Error("Instagram media asset has an invalid Storage object key.");
        return mediaStorage.createSignedUrl(key, 1800);
      },
      assertPublicationRights: async ({ content, operation }) => {
        assertContentUnchangedSincePublicationOperation(content, operation);
        const mediaAssetIds = content.mediaAssetIds ?? [];
        if (mediaAssetIds.length === 0) {
          throw new Error("Instagram publication cannot revalidate rights without configured media assets.");
        }
        const configuredAssets = await Promise.all(mediaAssetIds.map((id) => persistence.repositories.mediaAssets.findById(id)));
        if (configuredAssets.some((asset) => !asset)) {
          throw new Error("Instagram publication cannot revalidate rights because a configured media asset is missing.");
        }
        const mediaAssets = configuredAssets as NonNullable<(typeof configuredAssets)[number]>[];
        const linkedProducts = await persistence.repositories.contentProducts.listByContent(content.id);
        const linkedProductIds = [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
        const reservation = await persistence.repositories.publicationDispatchReservations?.findByJobProvider(operation.jobId, operation.provider);
        if (!reservation || reservation.contentId !== content.id || reservation.state === "failed") throw new Error("Instagram publication reservation is missing or invalid; final publication is blocked.");
        const currentIntegrity = await createPublicationMediaIntegritySnapshot(mediaAssets, linkedProductIds, persistence.repositories.productMediaAssets);
        assertPublicationMediaIntegritySnapshot((reservation.snapshot as {mediaIntegrity?:unknown}).mediaIntegrity, currentIntegrity);
        await assertProductMediaRightsForPublication(mediaAssets, linkedProductIds, persistence.repositories.productMediaAssets);
      }
    }
  }),
  socialCredentialResolver,
  fileSocialCredentialStore,
  new DrizzlePublicationOperationRepository(persistence.db),
  new DrizzleAutonomousRunRepository(persistence.db),
  environment.AUTONOMOUS_CYCLE_INTERVAL_MS,
  environment.SHOPEE_CONVERSION_SYNC_INTERVAL_MS,
  environment.SHOPEE_CONVERSION_SYNC_LOOKBACK_HOURS,
  new DrizzleAutonomousFeedbackMemoryRepository(persistence.db),
  autonomousCycleLock,
  persistence.optimizationState,
  persistence.optimizationState,
  {
    minimumScore: environment.AUTONOMOUS_MINIMUM_SCORE,
    maximumResults: environment.AUTONOMOUS_MAXIMUM_RESULTS,
    minimumCommissionRateBps: environment.AUTONOMOUS_MINIMUM_COMMISSION_BPS,
    minimumCommissionAmountCents: environment.AUTONOMOUS_MINIMUM_COMMISSION_AMOUNT_CENTS,
    minimumDemandScore: environment.AUTONOMOUS_MINIMUM_DEMAND_SCORE
  },
  environment.AUTONOMOUS_MARKETPLACE_POLICIES_JSON,
  persistence.autonomousDecisionAudits,
  persistence.autonomousActionOutcomes,
  { minimumCommissionPerClickCents: environment.AUTONOMOUS_OPTIMIZATION_MIN_COMMISSION_PER_CLICK_CENTS },
  {},
  {},
  persistence.autonomousExplorationStates,
  createOfficialTikTokContentPostingClient({ credentialResolver: socialCredentialResolver }),
  mediaStorage,
  undefined,
  environment.AUTONOMOUS_PUBLICATION_ENABLED,
  {
    clientId: environment.OPENVERSE_CLIENT_ID,
    clientSecret: environment.OPENVERSE_CLIENT_SECRET
  },
  persistence.preMediaEligibility,
  localProductMediaStorage,
  localProductMediaStorage && environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY && environment.PRODUCT_MEDIA_PUBLIC_BASE_URL
    ? async (asset, context) => {
        const token = createProductMediaDeliveryToken({
          assetId: asset.id,
          productId: asset.productId,
          contentId: context.contentId,
          reservationId: context.reservationId,
          sha256: asset.sha256,
          expiresAt: Math.floor(Date.now() / 1000) + 300
        }, { signingKey: environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY!, maximumLifetimeSeconds: 300 });
        const base = environment.PRODUCT_MEDIA_PUBLIC_BASE_URL!.replace(/\/+$/, "");
        return `${base}/api/v1/product-media/delivery/${token}`;
      }
    : undefined
);
// Local-volume preview URLs are issued only after the existing adminGuard has
// authorized the preview request. The public token endpoint serves no-store
// bytes and rechecks the current asset identity and on-disk SHA-256.
if (localProductMediaStorage && environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY &&
    environment.PRODUCT_MEDIA_PUBLIC_BASE_URL && persistence.repositories.productMediaAssets) {
  const existingPreviewUrl = services.productMediaPreviewUrl;
  services.productMediaPreviewUrl = async (productId, assetId) => {
    const asset = (await persistence.repositories.productMediaAssets!.listByProduct(productId))
      .find((candidate) => candidate.id === assetId);
    if (!asset) return undefined;
    if (asset.storageBackend !== "local_volume") return existingPreviewUrl?.(productId, assetId);
    const token = createProductMediaPreviewToken({
      assetId: asset.id,
      productId: asset.productId,
      sha256: asset.sha256,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    }, { signingKey: environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY!, maximumLifetimeSeconds: 300 });
    const base = environment.PRODUCT_MEDIA_PUBLIC_BASE_URL!.replace(/\/+$/, "");
    return `${base}/api/v1/product-media/preview/${token}`;
  };
  services.productMediaPreviewDelivery = (token) => authorizeProductMediaPreview({
    token,
    tokenConfig: { signingKey: environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY!, maximumLifetimeSeconds: 300 },
    assets: persistence.repositories.productMediaAssets!,
    readLocal: (key, maxBytes) => localProductMediaStorage.download(key, maxBytes),
    maximumBytes: 45 * 1024 * 1024
  });
}
const aiProductMediaStorage = localProductMediaStorage ?? mediaStorage;
if (environment.AI_PRODUCT_IMAGE_GENERATION_ENABLED && environment.OPENAI_API_KEY && aiProductMediaStorage && persistence.repositories.productMediaAssets) {
  services.productImageGeneration = new ProductImageGenerationService(
    persistence.repositories.products,
    persistence.repositories.productMediaAssets,
    aiProductMediaStorage,
    { apiKey: environment.OPENAI_API_KEY, model: environment.AI_PRODUCT_IMAGE_MODEL }
  );
  services.productIllustrativeImageGeneration = new ProductIllustrativeImageGenerationService(
    persistence.repositories.products,
    persistence.repositories.productMediaAssets,
    aiProductMediaStorage,
    { apiKey: environment.OPENAI_API_KEY, model: environment.AI_PRODUCT_IMAGE_MODEL }
  );
}
if (localProductMediaStorage && environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY && persistence.repositories.productMediaAssets && persistence.repositories.publicationDispatchReservations) {
  services.productMediaDelivery = (token) => authorizeProductMediaDelivery({
    token,
    tokenConfig: { signingKey: environment.PRODUCT_MEDIA_DELIVERY_SIGNING_KEY!, maximumLifetimeSeconds: 300 },
    assets: persistence.repositories.productMediaAssets!,
    reservations: persistence.repositories.publicationDispatchReservations!,
    readLocal: (key, maxBytes) => localProductMediaStorage.download(key, maxBytes),
    maximumBytes: 45 * 1024 * 1024
  });
}

const app = createApp(services, {
  providerEvents: persistence.providerEvents,
  readinessCheck: async () => {
    await persistence.db.execute(sql`SELECT 1`);
    await assertMediaSchemaReady(persistence.db);
  }
});

const providerEventProcessor = new ProviderEventConversionProcessor(
  new ProviderEventProcessor(persistence.providerEvents),
  new StaticProviderEventConversionNormalizerRegistry([new GenericProviderConversionNormalizer()]),
  services.providerConversions
);
const providerEventWorker = new ProviderEventWorker(persistence.providerEvents, providerEventProcessor);
const providerEventScheduler = new ProviderEventScheduler(providerEventWorker, {
  intervalMs: environment.PROVIDER_EVENT_WORKER_INTERVAL_MS,
  onError: (error) => app.log.error({ errorType: safeErrorType(error) }, "Provider event worker cycle failed")
});
persistence.providerEvents.setWakeSignal(() => providerEventScheduler.notifyChanged());

const shopeeIntakeRecoveryWorker = new ShopeeIntakeRecoveryWorker(services.shopeeAffiliateLinkIntakes, {
  batchSize: environment.SHOPEE_INTAKE_RECOVERY_BATCH_SIZE,
  concurrency: environment.SHOPEE_INTAKE_RECOVERY_CONCURRENCY,
  resolverTimeoutMs: environment.SHOPEE_INTAKE_RECOVERY_RESOLVER_TIMEOUT_MS
});
const shopeeIntakeRecoveryScheduler = new ShopeeIntakeRecoveryScheduler(shopeeIntakeRecoveryWorker, {
  intervalMs: environment.SHOPEE_INTAKE_RECOVERY_INTERVAL_MS,
  onResult: (result) => app.log.info({ ...result }, "Shopee stale intake recovery cycle completed"),
  onError: (error) => app.log.error({ errorType: safeErrorType(error) }, "Shopee stale intake recovery cycle failed")
});
services.shopeeAffiliateLinkIntakes.setRecoveryWakeSignal(() => shopeeIntakeRecoveryScheduler.notifyChanged());

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  services.publicationScheduler.start();
  providerEventScheduler.start();
  shopeeIntakeRecoveryScheduler.start();
  if (environment.SHOPEE_CONVERSION_SYNC_ENABLED) services.shopeeConversionSyncScheduler.start();
  if (environment.AUTONOMOUS_CYCLE_ENABLED) services.autonomousScheduler.start();
} catch (error) {
  app.log.error({ errorType: safeErrorType(error) }, "API startup failed");
  await services.autonomousScheduler.stop();
  await services.shopeeConversionSyncScheduler.stop();
  await services.publicationScheduler.stop();
  await providerEventScheduler.stop();
  await shopeeIntakeRecoveryScheduler.stop();
  await persistence.close();
  process.exit(1);
}

const shutdown = async () => {
  await services.autonomousScheduler.stop();
  await services.shopeeConversionSyncScheduler.stop();
  await services.publicationScheduler.stop();
  await providerEventScheduler.stop();
  await shopeeIntakeRecoveryScheduler.stop();
  await app.close();
  await persistence.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);