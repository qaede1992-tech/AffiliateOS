import { createApp } from "./app.js";
import { environment } from "./config.js";

const app = createApp();

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}