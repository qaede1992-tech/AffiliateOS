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
