import type { FastifyBaseLogger, FastifyRequest } from "fastify";

export type AuditEvent =
  | "authentication_failed"
  | "authorization_denied"
  | "marketplace_connection_enabled_changed"
  | "autonomous_run_retry_requested"
  | "autonomous_cycle_triggered"
  | "social_credential_rotated"
  | "social_credential_revoked"
  | "publication_job_confirmed"
  | "content_scheduled_for_distribution"
  | "shopee_affiliate_link_intake_submitted"
  | "product_media_rights_updated"
  | "product_media_candidate_reviewed"
  | "product_media_candidate_imported"
  | "product_media_uploaded";

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
