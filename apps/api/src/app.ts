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

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

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
    return reply.status(500).send({
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred."
    });
  });

  return app;
}
