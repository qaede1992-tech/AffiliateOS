export type PublisherHealthStatus = "ready" | "unconfigured" | "unsupported";

export type AutonomousHealthStatus = "disabled" | "degraded" | "healthy";

export function determineAutonomousHealthStatus(input: {
  schedulerRunning: boolean;
  schedulerLastError?: string | null;
  publisherStatuses: readonly PublisherHealthStatus[];
  recoverableRunCount: number;
}): AutonomousHealthStatus {
  if (!input.schedulerRunning) return "disabled";
  if (
    input.schedulerLastError ||
    input.publisherStatuses.includes("unconfigured") ||
    input.recoverableRunCount > 0
  ) {
    return "degraded";
  }
  return "healthy";
}
