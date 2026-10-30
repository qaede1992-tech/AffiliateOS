import assert from "node:assert/strict";
import test from "node:test";
import { PublisherReadinessService } from "../src/domain/publisher-readiness.js";
import type { SocialPublisher } from "../src/domain/distribution-engine.js";
import type { SocialAccount } from "@affiliateos/shared";
import { InMemorySocialCredentialResolver } from "../src/domain/social-credentials.js";

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
    status: "unconfigured",
    publisherConfigured: true,
    credentialResolutionConfigured: true,
    activeAccountConfigured: true,
    credentialReferenceConfigured: true,
    requiredScope: "instagram_business_content_publish",
    requiredScopeGranted: true,
    credentialResolvable: false
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

test("TikTok becomes ready after the opaque credential reference resolves", async () => {
  const tiktokPublisher: SocialPublisher = {
    provider: "tiktok-provider",
    supports: (platform) => platform === "tiktok"
  };
  const repository = { list: async () => [account({
    platform: "tiktok",
    connection: { grantedScopes: ["video.publish"] },
    credentialReference: "secret://social/tiktok"
  })] };
  const credentials = new InMemorySocialCredentialResolver();
  credentials.set("secret://social/tiktok", { accessToken: "redacted-test-value" });
  const service = new PublisherReadinessService([tiktokPublisher], true, repository, credentials);

  const result = (await service.list()).find((item) => item.platform === "tiktok");
  assert.equal(result?.status, "ready");
  assert.equal(result?.credentialResolvable, true);
});

test("TikTok stays unconfigured when credential resolution fails", async () => {
  const tiktokPublisher: SocialPublisher = {
    provider: "tiktok-provider",
    supports: (platform) => platform === "tiktok"
  };
  const repository = { list: async () => [account({
    platform: "tiktok",
    connection: { grantedScopes: ["video.publish"] },
    credentialReference: "secret://social/tiktok"
  })] };
  const service = new PublisherReadinessService(
    [tiktokPublisher],
    true,
    repository,
    new InMemorySocialCredentialResolver()
  );

  const result = (await service.list()).find((item) => item.platform === "tiktok");
  assert.equal(result?.status, "unconfigured");
  assert.equal(result?.credentialResolvable, false);
});

test("publisher readiness does not combine one account's credential with another account's scope", async () => {
  const credentials = new InMemorySocialCredentialResolver();
  credentials.set("secret://social/valid-without-scope", { accessToken: "redacted-test-value" });
  const repository = {
    list: async () => [
      account({
        id: "credential-account",
        credentialReference: "secret://social/valid-without-scope",
        connection: { grantedScopes: ["instagram_business_basic"] }
      }),
      account({
        id: "scope-account",
        credentialReference: "secret://social/missing",
        connection: { grantedScopes: ["instagram_business_content_publish"] }
      })
    ]
  };
  const service = new PublisherReadinessService([publisher], true, repository, credentials);

  const result = (await service.list()).find((item) => item.platform === "instagram");
  assert.equal(result?.status, "unconfigured");
  assert.equal(result?.credentialResolvable, true);
  assert.equal(result?.requiredScopeGranted, false);
});

test("publisher readiness does not treat another account's scope as optional when the credential account has no scope evidence", async () => {
  const credentials = new InMemorySocialCredentialResolver();
  credentials.set("secret://social/valid-without-scope-metadata", { accessToken: "redacted-test-value" });
  const repository = {
    list: async () => [
      account({
        id: "credential-account",
        credentialReference: "secret://social/valid-without-scope-metadata",
        connection: {}
      }),
      account({
        id: "scope-account",
        credentialReference: "secret://social/missing",
        connection: { grantedScopes: ["instagram_business_content_publish"] }
      })
    ]
  };
  const service = new PublisherReadinessService([publisher], true, repository, credentials);

  const result = (await service.list()).find((item) => item.platform === "instagram");
  assert.equal(result?.status, "unconfigured");
  assert.equal(result?.credentialResolvable, true);
  assert.equal(result?.requiredScopeGranted, false);
});

test("publisher readiness accepts a credential and publishing scope from the same account", async () => {
  const credentials = new InMemorySocialCredentialResolver();
  credentials.set("secret://social/instagram-ready", { accessToken: "redacted-test-value" });
  const repository = {
    list: async () => [
      account({
        id: "ready-account",
        credentialReference: "secret://social/instagram-ready",
        connection: { grantedScopes: ["instagram_business_content_publish"] }
      }),
      account({
        id: "unrelated-account",
        credentialReference: "secret://social/missing",
        connection: { grantedScopes: ["instagram_business_basic"] }
      })
    ]
  };
  const service = new PublisherReadinessService([publisher], true, repository, credentials);

  const result = (await service.list()).find((item) => item.platform === "instagram");
  assert.equal(result?.status, "ready");
  assert.equal(result?.credentialResolvable, true);
  assert.equal(result?.requiredScopeGranted, true);
});

test("Threads and X remain explicitly unsupported until an official publisher is registered", async () => {
  const service = new PublisherReadinessService([], false);

  const readiness = await service.list();
  const threads = readiness.find((item) => item.platform === "threads");
  const x = readiness.find((item) => item.platform === "x");

  assert.equal(threads?.status, "unsupported");
  assert.equal(threads?.publisherConfigured, false);
  assert.equal(x?.status, "unsupported");
  assert.equal(x?.publisherConfigured, false);
});
