import assert from "node:assert/strict";
import test from "node:test";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import { PublisherReadinessService } from "../../src/domain/publisher-readiness.js";

const publisher: SocialPublisher = {
  supports: (platform) => platform === "instagram",
  publish: async () => ({ externalPostId: "external-1" })
};

test("publisher readiness reports unsupported platforms without adapters", () => {
  const service = new PublisherReadinessService([], false);
  assert.equal(service.get("instagram").status, "unsupported");
  assert.equal(service.get("instagram").publisherConfigured, false);
});

test("publisher readiness reports adapter configured but credential resolution unavailable", () => {
  const service = new PublisherReadinessService([publisher], false);
  assert.deepEqual(service.get("instagram"), {
    platform: "instagram",
    status: "unconfigured",
    publisherConfigured: true,
    credentialResolutionConfigured: false,
    activeAccountConfigured: false,
    credentialReferenceConfigured: false
  });
});

test("publisher readiness reports ready when adapter and credential resolver are configured", () => {
  const service = new PublisherReadinessService([publisher], true);
  assert.deepEqual(service.get("instagram"), {
    platform: "instagram",
    status: "unconfigured",
    publisherConfigured: true,
    credentialResolutionConfigured: true,
    activeAccountConfigured: false,
    credentialReferenceConfigured: false
  });
});


test("publisher readiness requires an active account credential reference to resolve", async () => {
  const service = new PublisherReadinessService([publisher], true, {
    list: async () => [{
      id: "social-1", platform: "instagram", accountReference: "ig-account", status: "active",
      connection: {}, credentialReference: "vault://missing", createdAt: "", updatedAt: ""
    }]
  } as never, {
    resolve: async () => { throw new Error("missing credential"); }
  });
  const readiness = (await service.list()).find((item) => item.platform === "instagram");
  assert.equal(readiness?.status, "unconfigured");
  assert.equal(readiness?.credentialResolvable, false);
});

test("publisher readiness becomes ready when an active account credential reference resolves", async () => {
  const service = new PublisherReadinessService([publisher], true, {
    list: async () => [{
      id: "social-1", platform: "instagram", accountReference: "ig-account", status: "active",
      connection: {}, credentialReference: "vault://instagram", createdAt: "", updatedAt: ""
    }]
  } as never, {
    resolve: async (reference: string) => reference === "vault://instagram" ? "access-token" : undefined
  });
  const readiness = (await service.list()).find((item) => item.platform === "instagram");
  assert.equal(readiness?.status, "ready");
  assert.equal(readiness?.credentialResolvable, true);
});
