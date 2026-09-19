import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import type { HealthResponse } from "@affiliateos/shared";
import { createInMemoryServices, type Services } from "./domain/container.js";
import { DomainError } from "./domain/errors.js";
import { authenticateRequest, type AuthConfig, type OperatorRole } from "./http/auth.js";
import { configuredRateLimit, InMemoryRateLimiter } from "./http/rate-limit.js";
import { registerResourceRoutes } from "./http/routes.js";

const configuredCorsOrigin = () => process.env.API_CORS_ORIGIN?.trim() || "http://localhost:5173";

const configuredAuth = (): AuthConfig => {
  const token = process.env.API_AUTH_TOKEN?.trim();
  const production = process.env.NODE_ENV === "production";
  if (production && (!token || token.length < 32)) {
    throw new Error("API_AUTH_TOKEN must be at least 32 characters in production.");
  }

  const role = (process.env.API_AUTH_OPERATOR_ROLE?.trim() || "admin") as OperatorRole;
  if (!["admin", "operator", "viewer"].includes(role)) {
    throw new Error("API_AUTH_OPERATOR_ROLE must be admin, operator, or viewer.");
  }

  return {
    enabled: production || Boolean(token),
    token,
    operatorId: process.env.API_AUTH_OPERATOR_ID?.trim() || "development-operator",
    role
  };
};

type AppOptions = {
  readinessCheck?: () => Promise<void>;
  auth?: AuthConfig;
  rateLimit?: { enabled: boolean; limit: number; windowMs: number };
};

export function createApp(services: Services = createInMemoryServices(), options: AppOptions = {}) {
  const auth = options.auth ?? configuredAuth();
  const rateLimitConfig = options.rateLimit ?? configuredRateLimit();
  const rateLimiter = rateLimitConfig.enabled
    ? new InMemoryRateLimiter(rateLimitConfig.limit, rateLimitConfig.windowMs)
    : null;

  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.credentialReference",
        "req.body.configuration.*",
        "req.query.code",
        "req.query.state"
      ]
    },
    bodyLimit: 1_048_576
  });

  app.decorateRequest("auth", null);
  app.register(cors, { origin: configuredCorsOrigin() });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    if (request.url === "/api/v1/health" || request.url === "/api/v1/ready") return;

    if (rateLimiter) {
      const result = rateLimiter.consume(request.ip);
      reply.header("X-RateLimit-Limit", result.limit);
      reply.header("X-RateLimit-Remaining", result.remaining);
      if (!result.allowed) {
        reply.header("Retry-After", result.retryAfterSeconds);
        return reply.status(429).send({
          error: "RATE_LIMITED",
          message: "Too many requests. Please retry later."
        });
      }
    }

    const context = authenticateRequest(request, auth);
    if (!context) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Authentication is required." });
    }
    request.auth = context;
  });

  app.get<{ Reply: HealthResponse }>("/api/v1/health", async () => ({
    status: "ok",
    service: "affiliateos-api",
    timestamp: new Date().toISOString()
  }));

  app.get("/api/v1/ready", async (_request, reply) => {
    if (!options.readinessCheck) {
      return reply.send({ status: "ready", service: "affiliateos-api" });
    }

    try {
      await options.readinessCheck();
      return reply.send({ status: "ready", service: "affiliateos-api" });
    } catch (error) {
      app.log.warn({ err: error }, "database readiness check failed");
      return reply.status(503).send({ status: "not_ready", service: "affiliateos-api" });
    }
  });

  app.get("/api/v1/auth/me", async (request) => ({ authenticated: true, operatorId: request.auth!.operatorId, role: request.auth!.role }));

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
