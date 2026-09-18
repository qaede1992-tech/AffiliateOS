import { createApp } from "./app.js";
import { environment } from "./config.js";
import { createServices } from "./domain/container.js";
import { createDatabasePersistence } from "./db/client.js";
import { DrizzleAnalyticsReader } from "./db/analytics.js";
import { DrizzleConversionAttributionRepository } from "./db/attribution.js";
import { DrizzleOAuthStateRepository } from "./db/oauth-state.js";

const persistence = createDatabasePersistence(environment.DATABASE_URL);
const services = createServices(
  persistence.repositories,
  persistence.transactionManager,
  undefined,
  undefined,
  new DrizzleOAuthStateRepository(persistence.db),
  new DrizzleAnalyticsReader(persistence.db),
  new DrizzleConversionAttributionRepository(persistence.db)
);
const app = createApp(services);

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.error(error);
  await persistence.close();
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  await persistence.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
