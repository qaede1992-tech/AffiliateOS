import cors from "@fastify/cors";
import Fastify from "fastify";
import type { HealthResponse } from "@affiliateos/shared";

export function createApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });

  app.get<{ Reply: HealthResponse }>("/api/v1/health", async () => ({
    status: "ok",
    service: "affiliateos-api",
    timestamp: new Date().toISOString()
  }));

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return reply.status(500).send({
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred."
    });
  });

  return app;
}