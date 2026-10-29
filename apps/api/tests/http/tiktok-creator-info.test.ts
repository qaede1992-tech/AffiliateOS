import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import type { Services } from "../../src/domain/container.js";
import { TikTokProviderRequestError } from "../../src/domain/tiktok-content-posting-client.js";

test("TikTok Creator Info maps provider rejection to a safe 502 response", async () => {
  const socialAccountId = "11111111-1111-4111-8111-111111111111";
  const account = {
    id: socialAccountId,
    platform: "tiktok",
    accountReference: "creator-1",
    status: "active",
    connection: {},
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z"
  };
  const services = {
    socialAccounts: {
      getForProviderOperation: async (id: string) => {
        assert.equal(id, socialAccountId);
        return account;
      }
    },
    tiktokCreatorInfo: {
      getCreatorInfo: async () => {
        throw new TikTokProviderRequestError(401, "access_token_invalid", "The access token is invalid or not found in the request.");
      }
    }
  } as unknown as Services;
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "test", role: "admin" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/social-accounts/${socialAccountId}/tiktok/creator-info`
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "TIKTOK_PROVIDER_REQUEST_FAILED",
    message: "TikTok did not accept the Creator Info request. Verify the account connection and try again."
  });
  assert.equal(JSON.stringify(response.json()).includes("access token is invalid"), false);
  await app.close();
});
