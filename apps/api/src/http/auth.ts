import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export type OperatorRole = "admin" | "operator" | "viewer";

export type AuthContext = {
  operatorId: string;
  role: OperatorRole;
};

export type AuthConfig = {
  enabled: boolean;
  token?: string;
  operatorId: string;
  role: OperatorRole;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function authenticateRequest(request: FastifyRequest, config: AuthConfig): AuthContext | null {
  if (!config.enabled) return { operatorId: config.operatorId, role: config.role };
  if (!config.token) return null;

  const header = request.headers.authorization;
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return null;

  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(config.token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  return { operatorId: config.operatorId, role: config.role };
}

export function requireOperator(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.auth || !["admin", "operator"].includes(request.auth.role)) {
    void reply.status(403).send({ error: "FORBIDDEN", message: "An authorized operator is required." });
    return false;
  }
  return true;
}
