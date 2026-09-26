import assert from "node:assert/strict";
import test from "node:test";
import { PublisherReadinessService } from "../src/domain/publisher-readiness.js";
import type { SocialPublisher } from "../src/domain/distribution-engine.js";
import type { SocialAccount } from "@affiliateos/shared";

const publisher: SocialPublisher = {
  provider: "test-provider",
  supports: (platform) => platform === "instagram"
};

const account = (overrides: Partial<SocialAccount> = {}): SocialAccount => ({
  id: "account-1",
  platform: "instagram",
  accountReference: "instagram-account",
  status: "active",
  connection: {},
  credentialReference: "secret://social/instagram",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...overrides
});

test("publisher readiness requires an active account and credential reference", async () => {
  const repository = { list: async () => [account()] };
  const service = new PublisherReadinessService([publisher], true, repository);

  const ready = (await service.list()).find((item) => item.platform === "instagram");
  assert.deepEqual(ready, {
    platform: "instagram",
    status: "ready",
    publisherConfigured: true,
    credentialResolutionConfigured: true,
    activeAccountConfigured: true,
    credentialReferenceConfigured: true,
    requiredScope: "instagram_business_content_publish",
    requiredScopeGranted: false
  });

  const missingCredential = new PublisherReadinessService([publisher], true, {
    list: async () => [account({ credentialReference: undefined })]
  });
  assert.equal((await missingCredential.list()).find((item) => item.platform === "instagram")?.status, "unconfigured");

  const noAccount = new PublisherReadinessService([publisher], true, { list: async () => [] });
  assert.equal((await noAccount.list()).find((item) => item.platform === "instagram")?.status, "unconfigured");
});


test("Instagram becomes ready only after the publishing scope is granted", () => {
  const service = new PublisherReadinessService([publisher], true);
  const result = service.get("instagram", [account({ connection: { grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"] } })]);
  assert.equal(result.status, "ready");
  assert.equal(result.requiredScopeGranted, true);
});

test("TikTok remains unconfigured when the video publishing scope is missing", () => {
  const tiktokPublisher: SocialPublisher = { provider: "tiktok-provider", supports: (platform) => platform === "tiktok" };
  const service = new PublisherReadinessService([tiktokPublisher], true);
  const result = service.get("tiktok", [account({ platform: "tiktok", connection: { grantedScopes: ["user.info.basic"] } })]);
  assert.equal(result.status, "unconfigured");
  assert.equal(result.requiredScope, "video.publish");
  assert.equal(result.requiredScopeGranted, false);
});
