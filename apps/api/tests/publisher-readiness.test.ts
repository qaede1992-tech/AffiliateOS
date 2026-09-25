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
    credentialReferenceConfigured: true
  });

  const missingCredential = new PublisherReadinessService([publisher], true, {
    list: async () => [account({ credentialReference: undefined })]
  });
  assert.equal((await missingCredential.list()).find((item) => item.platform === "instagram")?.status, "unconfigured");

  const noAccount = new PublisherReadinessService([publisher], true, { list: async () => [] });
  assert.equal((await noAccount.list()).find((item) => item.platform === "instagram")?.status, "unconfigured");
});
