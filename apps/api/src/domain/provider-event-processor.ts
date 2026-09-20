import { DomainError } from "./errors.js";

export type ProcessableProviderEvent = {
  affiliateAccountId: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureVersion?: string | null;
  status: string;
  receivedAt: string;
};

export interface ProviderEventInbox {
  findByExternalId(affiliateAccountId: string, externalEventId: string): Promise<ProcessableProviderEvent | undefined>;
  claimForProcessing(affiliateAccountId: string, externalEventId: string): Promise<boolean>;
  updateStatus(affiliateAccountId: string, externalEventId: string, status: "received" | "processing" | "processed" | "failed", error?: string): Promise<boolean>;
}

export class ProviderEventProcessor {
  constructor(private readonly inbox: ProviderEventInbox) {}

  async process<T>(affiliateAccountId: string, externalEventId: string, handler: (event: ProcessableProviderEvent) => Promise<T>): Promise<{ processed: boolean; result?: T }> {
    const event = await this.inbox.findByExternalId(affiliateAccountId, externalEventId);
    if (!event) throw new DomainError("PROVIDER_EVENT_NOT_FOUND", "The provider event does not exist.", 404);
    if (event.status === "processed") return { processed: false };

    const claimed = await this.inbox.claimForProcessing(affiliateAccountId, externalEventId);
    if (!claimed) return { processed: false };

    const processingEvent = { ...event, status: "processing" };
    try {
      const result = await handler(processingEvent);
      const updated = await this.inbox.updateStatus(affiliateAccountId, externalEventId, "processed");
      if (!updated) throw new Error("Provider event disappeared while marking it processed.");
      return { processed: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider event processing failed.";
      await this.inbox.updateStatus(affiliateAccountId, externalEventId, "failed", message);
      throw error;
    }
  }
}
