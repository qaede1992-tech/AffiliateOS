import type { FastifyBaseLogger, FastifyRequest } from "fastify";

export type AuditEvent =
  | "authentication_failed"
  | "authorization_denied"
  | "marketplace_connection_enabled_changed"\n  | "autonomous_run_retry_requested"\n  | "autonomous_cycle_triggered"\n  | "social_credential_rotated"\n  | "social_credential_revoked";

export function auditSecurityEvent(
  log: FastifyBaseLogger,
  request: FastifyRequest,
  event: AuditEvent,
  details: Record<string, string | boolean | undefined> = {}
): void {
  log.warn(
    {
      event,
      requestId: request.id,
      operatorId: request.auth?.operatorId,
      role: request.auth?.role,
      ...details
    },
    `security_audit:${event}`
  );
}
