import { sql } from "drizzle-orm";
import { createApp } from "./app.js";
import { environment } from "./config.js";
import { createServices } from "./domain/container.js";
import { createDatabasePersistence } from "./db/client.js";
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
import { ProviderEventConversionProcessor, StaticProviderEventConversionNormalizerRegistry } from "./domain/provider-event-conversion-processor.js";
import { GenericProviderConversionNormalizer } from "./domain/provider-conversion.js";

const persistence = createDatabasePersistence(environment.DATABASE_URL);
const autonomousCycleLock = new PostgresAutonomousCycleLock(persistence.pool);
const services = createServices(
  persistence.repositories,
  persistence.transactionManager,
  undefined,
  undefined,
  new DrizzleOAuthStateRepository(persistence.db),
  new DrizzleAnalyticsReader(persistence.db),
  new DrizzleConversionAttributionRepository(persistence.db),
  [],
  undefined,
  new DrizzlePublicationOperationRepository(persistence.db),
  new DrizzleAutonomousRunRepository(persistence.db),
  environment.AUTONOMOUS_CYCLE_INTERVAL_MS,
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
  { minimumCommissionPerClickCents: environment.AUTONOMOUS_OPTIMIZATION_MIN_COMMISSION_PER_CLICK_CENTS }
);
const app = createApp(services, {
  providerEvents: persistence.providerEvents,
  readinessCheck: async () => {
    await persistence.db.execute(sql`SELECT 1`);
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
  onError: (error) => app.log.error(error, "Provider event worker cycle failed")
});

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  services.publicationScheduler.start();
  providerEventScheduler.start();
  if (environment.AUTONOMOUS_CYCLE_ENABLED) services.autonomousScheduler.start();
} catch (error) {
  app.log.error(error);
  await services.autonomousScheduler.stop();
  await services.publicationScheduler.stop();
  await providerEventScheduler.stop();
  await persistence.close();
  process.exit(1);
}

const shutdown = async () => {
  await services.autonomousScheduler.stop();
  await services.publicationScheduler.stop();
  await providerEventScheduler.stop();
  await app.close();
  await persistence.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);