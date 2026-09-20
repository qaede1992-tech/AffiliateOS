import type { Content, SocialAccount } from "@affiliateos/shared";
import type { ContentService } from "./content.js";
import type { SocialAccountRepository } from "./repository.js";
import type { SocialPublisher } from "./distribution-engine.js";

export type PublishExecutionResult = {
  content: Content;
  account: SocialAccount;
  externalPostId?: string;
  status: "published" | "not_due" | "unsupported" | "failed";
};

export class PublisherExecutor {
  constructor(
    private readonly contentService: ContentService,
    private readonly socialAccounts: SocialAccountRepository,
    private readonly publishers: SocialPublisher[]
  ) {}

  async execute(contentId: string, now = new Date()): Promise<PublishExecutionResult> {
    const content = await this.contentService.get(contentId);
    if (content.status !== "scheduled") {
      throw new Error("Only scheduled content can be published.");
    }

    const scheduledAt = content.scheduledAt ? new Date(content.scheduledAt) : null;
    if (!scheduledAt || !Number.isFinite(scheduledAt.getTime())) {
      throw new Error("Scheduled content requires a valid scheduledAt timestamp.");
    }
    if (scheduledAt.getTime() > now.getTime()) {
      const account = await this.findAccount(content.platform);
      return { content, account, status: "not_due" };
    }

    const account = await this.findAccount(content.platform);
    const publisher = this.publishers.find((candidate) => candidate.supports(content.platform));
    if (!publisher) return { content, account, status: "unsupported" };

    try {
      const result = await publisher.publish({ content, account });
      const publishedAt = now.toISOString();
      const updated = await this.contentService.update(content.id, {
        status: "published",
        publishedAt
      });
      return { content: updated, account, externalPostId: result.externalPostId, status: "published" };
    } catch (error) {
      await this.contentService.update(content.id, { status: "failed" });
      throw error;
    }
  }

  private async findAccount(platform: string): Promise<SocialAccount> {
    const accounts = await this.socialAccounts.list();
    const account = accounts.find((candidate) => candidate.status === "active" && candidate.platform === platform);
    if (!account) throw new Error(`No active social account is available for ${platform}.`);
    return account;
  }
}
