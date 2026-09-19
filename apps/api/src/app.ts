import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import type { HealthResponse } from "@affiliateos/shared";
import { createInMemoryServices, type Services } from "./domain/container.js";
import { DomainError } from "./domain/errors.js";
import { registerResourceRoutes } from "./http/routes.js";

const configuredCorsOrigin = () => process.env.API_CORS_ORIGIN?.trim() || "http://localhost:5173";

export function createApp(services: Services = createInMemoryServices()) {
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.body.credentialReference", "req.body.configuration.*"] },
    bodyLimit: 1_048_576
  });

  app.register(cors, { origin: configuredCorsOrigin() });

  app.get<{ Reply: HealthResponse }>("/api/v1/health", async () => ({
    status: "ok",
    service: "affiliateos-api",
    timestamp: new Date().toISOString()
  }));

  registerResourceRoutes(app, services);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: "VALIDATION_ERROR", message: "The request body is invalid." });
    }

    const statusCode =
      error !== null && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const safeStatusCode = statusCode >= 400 && statusCode < 500 ? statusCode : 500;

    return reply.status(safeStatusCode).send({
      error: "INTERNAL_SERVER_ERROR",
      message: safeStatusCode === 500 ? "An unexpected error occurred." : "The request could not be processed."
    });
  });

  return app;
}
