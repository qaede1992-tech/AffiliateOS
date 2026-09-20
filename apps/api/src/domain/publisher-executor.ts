import type { Content, SocialAccount } from "@affiliateos/shared";
import type { ContentService } from "./content.js";
import { publisherSupportsContent, type PublicationCheckResult, type SocialPublisher } from "./distribution-engine.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { SocialAccountRepository } from "./repository.js";
import type { SocialCredentialResolver } from "./social-credentials.js";

export type PublishExecutionResult = {
  content: Content;
  account?: SocialAccount;
  publisher?: SocialPublisher;
  provider?: string;
  providerOperationId?: string;
  externalPostId?: string;
  status: "published" | "accepted" | "not_due" | "unsupported" | "failed";
};

export class PublisherExecutor {
  constructor(
    private readonly contentService: ContentService,
    private readonly socialAccounts: SocialAccountRepository,
    private readonly publishers: SocialPublisher[],
    private readonly credentialResolver?: SocialCredentialResolver
  ) {}

  async execute(contentId: string, now = new Date(), idempotencyKey = `content:${contentId}`): Promise<PublishExecutionResult> {
    const content = await this.contentService.get(contentId);
    if (content.status !== "scheduled") throw new Error("Only scheduled content can be published.");
    const scheduledAt = content.scheduledAt ? new Date(content.scheduledAt) : null;
    if (!scheduledAt || !Number.isFinite(scheduledAt.getTime())) throw new Error("Scheduled content requires a valid scheduledAt timestamp.");
    if (scheduledAt.getTime() > now.getTime()) return { content, status: "not_due" };

    const account = await this.findAccount(content);
    const publisher = this.publishers.find((candidate) => publisherSupportsContent(candidate, content));
    if (!publisher) return { content, account, status: "unsupported" };

    try {
      const credential = await this.resolveCredential(account);
      const result = await publisher.publish({ content, account, credential, idempotencyKey });
      if (result.status === "accepted") {
        return { content, account, publisher, provider: publisher.provider ?? content.platform, providerOperationId: result.providerOperationId, status: "accepted" };
      }
      const updated = await this.contentService.update(content.id, { status: "published", publishedAt: now.toISOString() });
      return { content: updated, account, publisher, provider: publisher.provider ?? content.platform, externalPostId: result.externalPostId, status: "published" };
    } catch (error) {
      await this.contentService.update(content.id, { status: "failed" });
      throw error;
    }
  }

  async check(operation: PublicationOperation): Promise<{ content: Content; account: SocialAccount; result: PublicationCheckResult }> {
    const content = await this.contentService.get(operation.contentId);
    const account = await this.findAccount(content);
    const publisher = this.publishers.find((candidate) => publisherSupportsContent(candidate, content) && (candidate.provider ?? content.platform) === operation.provider);
    if (!publisher) throw new Error(`No publisher adapter is available for provider ${operation.provider}.`);
    if (!publisher.checkPublication) throw new Error(`Publisher ${operation.provider} does not support publication status checks.`);
    const credential = await this.resolveCredential(account);
    const result = await publisher.checkPublication({ content, account, credential, operation });
    return { content, account, result };
  }

  private async resolveCredential(account: SocialAccount): Promise<unknown> {
    if (!account.credentialReference) return undefined;
    if (!this.credentialResolver) throw new Error("Social credential resolution is not configured.");
    return this.credentialResolver.resolve(account.credentialReference);
  }

  private async findAccount(content: Content): Promise<SocialAccount> {
    const accounts = await this.socialAccounts.list();
    if (content.socialAccountId) {
      const account = accounts.find((candidate) => candidate.id === content.socialAccountId);
      if (!account) throw new Error("The configured social account does not exist.");
      if (account.status !== "active") throw new Error("The configured social account is not active.");
      if (account.platform !== content.platform) throw new Error("The configured social account platform does not match content platform.");
      return account;
    }
    const account = accounts.find((candidate) => candidate.status === "active" && candidate.platform === content.platform);
    if (!account) throw new Error(`No active social account is available for ${content.platform}.`);
    return account;
  }
}
