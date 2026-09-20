import type { Content, ContentPlatform, SocialAccount } from "@affiliateos/shared";
import type { ContentService } from "./content.js";
import type { PublicationJobService } from "./publication-job-service.js";
import type { SocialAccountRepository } from "./repository.js";

export type DistributionRequest = {
  content: Content;
  scheduledAt: string;
  accountId?: string;
};

export type DistributionPlan = {
  content: Content;
  account: SocialAccount;
  scheduledAt: string;
  publishable: boolean;
};

export interface SocialPublisher {
  supports(platform: string): boolean;
  publish(input: { content: Content; account: SocialAccount; credential?: unknown; idempotencyKey: string }): Promise<{ externalPostId: string }>;
}

const platformMatches = (content: Content, account: SocialAccount) => content.platform === account.platform;

export class DistributionEngine {
  constructor(
    private readonly contentService: ContentService,
    private readonly socialAccounts: SocialAccountRepository,
    private readonly publishers: SocialPublisher[] = [],
    private readonly publicationJobs?: PublicationJobService
  ) {}

  async schedule(request: DistributionRequest): Promise<DistributionPlan> {
    const scheduledAt = new Date(request.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("Distribution requires a valid scheduledAt timestamp.");
    if (request.content.status !== "draft") {
      throw new Error("Only draft content can be scheduled for distribution.");
    }

    const accounts = await this.socialAccounts.list();
    const account = request.accountId
      ? accounts.find((candidate) => candidate.id === request.accountId)
      : accounts.find((candidate) => candidate.status === "active" && platformMatches(request.content, candidate));
    if (!account) throw new Error(`No social account is available for ${request.content.platform}.`);
    if (account.status !== "active") throw new Error("Distribution requires an active social account.");
    if (!platformMatches(request.content, account)) throw new Error("Distribution account platform does not match content platform.");

    const updated = await this.contentService.update(request.content.id, {
      status: "scheduled",
      scheduledAt: scheduledAt.toISOString(),
      socialAccountId: account.id
    });
    if (this.publicationJobs) await this.publicationJobs.enqueue(updated);
    const publishable = this.publishers.some((publisher) => publisher.supports(request.content.platform));
    return { content: updated, account, scheduledAt: scheduledAt.toISOString(), publishable };
  }

  listPublishers(platform?: ContentPlatform): SocialPublisher[] {
    return platform ? this.publishers.filter((publisher) => publisher.supports(platform)) : [...this.publishers];
  }
}
