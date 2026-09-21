import { sql } from "drizzle-orm";
import { createApp } from "./app.js";
import { environment } from "./config.js";
import { createServices } from "./domain/container.js";
import { createDatabasePersistence } from "./db/client.js";
import { DrizzleAnalyticsReader } from "./db/analytics.js";
import { DrizzleConversionAttributionRepository } from "./db/attribution.js";
import { DrizzleOAuthStateRepository } from "./db/oauth-state.js";
import { DrizzlePublicationOperationRepository } from "./db/publication-operation-repository.js";
import { DrizzleAutonomousRunRepository } from "./db/autonomous-run-repository.js";
import { DrizzleAutonomousFeedbackMemoryRepository } from "./db/autonomous-feedback-memory-repository.js";
import { DrizzleAutonomousOptimizationStateRepository } from "./db/autonomous-optimization-state-repository.js";

const persistence = createDatabasePersistence(environment.DATABASE_URL);
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
  new DrizzleAutonomousOptimizationStateRepository(persistence.db),
  { publicationDelayMs: environment.AUTONOMOUS_PUBLICATION_DELAY_MS }
);
const app = createApp(services, {
  providerEvents: persistence.providerEvents,
  readinessCheck: async () => {
    await persistence.db.execute(sql`SELECT 1`);
  }
});

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  services.publicationScheduler.start();
  if (environment.AUTONOMOUS_CYCLE_ENABLED) services.autonomousScheduler.start();
} catch (error) {
  app.log.error(error);
  await services.autonomousScheduler.stop();
  await services.publicationScheduler.stop();
  await persistence.close();
  process.exit(1);
}

const shutdown = async () => {
  await services.autonomousScheduler.stop();
  await services.publicationScheduler.stop();
  await app.close();
  await persistence.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);