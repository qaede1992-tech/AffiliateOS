import type { Content, ContentPlatform, SocialAccount } from "@affiliateos/shared";
import type { ContentService } from "./content.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { SocialAccountRepository } from "./repository.js";

export type DistributionRequest = { content: Content; scheduledAt: string; accountId?: string };
export type DistributionPlan = { content: Content; account: SocialAccount; scheduledAt: string; publishable: boolean };

export type PublishOutcome =
  | { status: "published"; externalPostId: string }
  | { status: "accepted"; providerOperationId: string };

export type PublicationCheckResult =
  | { status: "processing" }
  | { status: "published"; externalPostId: string }
  | { status: "failed"; error: string };

export interface SocialPublisher {
  supports(platform: string): boolean;
  supportsContent?(content: Content): boolean;
  provider?: string;
  publish(input: { content: Content; account: SocialAccount; credential?: unknown; idempotencyKey: string }): Promise<PublishOutcome>;
  checkPublication?(input: { content: Content; account: SocialAccount; credential?: unknown; operation: PublicationOperation }): Promise<PublicationCheckResult>;
}

export const publisherSupportsContent = (publisher: SocialPublisher, content: Content): boolean =>
  publisher.supports(content.platform) && (publisher.supportsContent?.(content) ?? true);

const platformMatches = (content: Content, account: SocialAccount) => content.platform === account.platform;

export class DistributionEngine {
  constructor(private readonly contentService: ContentService, private readonly socialAccounts: SocialAccountRepository, private readonly publishers: SocialPublisher[] = [], private readonly publicationJobs?: import("./publication-job-service.js").PublicationJobService) {}

  async validate(request: DistributionRequest): Promise<SocialAccount> {
    const scheduledAt = new Date(request.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("Distribution requires a valid scheduledAt timestamp.");
    if (request.content.status !== "draft") throw new Error("Only draft content can be scheduled for distribution.");
    const accounts = await this.socialAccounts.list();
    const account = request.accountId ? accounts.find((candidate) => candidate.id === request.accountId) : accounts.find((candidate) => candidate.status === "active" && platformMatches(request.content, candidate));
    if (!account) throw new Error(`No social account is available for ${request.content.platform}.`);
    if (account.status !== "active") throw new Error("Distribution requires an active social account.");
    if (!platformMatches(request.content, account)) throw new Error("Distribution account platform does not match content platform.");
    return account;
  }

  async schedule(request: DistributionRequest): Promise<DistributionPlan> {
    const scheduledAt = new Date(request.scheduledAt);
    const account = await this.validate(request);
    const updated = await this.contentService.update(request.content.id, { status: "scheduled", scheduledAt: scheduledAt.toISOString(), socialAccountId: account.id });
    if (this.publicationJobs) {
      try { await this.publicationJobs.enqueue(updated); }
      catch (error) {
        await this.contentService.update(request.content.id, { status: "draft", scheduledAt: undefined, socialAccountId: undefined });
        throw error;
      }
    }
    const publishable = this.publishers.some((publisher) => publisherSupportsContent(publisher, request.content));
    return { content: updated, account, scheduledAt: scheduledAt.toISOString(), publishable };
  }

  async validateBatch(requests: DistributionRequest[]): Promise<SocialAccount[]> {
    const accounts: SocialAccount[] = [];
    for (const request of requests) accounts.push(await this.validate(request));
    return accounts;
  }

  listPublishers(platform?: ContentPlatform): SocialPublisher[] { return platform ? this.publishers.filter((publisher) => publisher.supports(platform)) : [...this.publishers]; }
}
