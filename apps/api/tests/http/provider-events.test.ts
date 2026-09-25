import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import { MarketplaceProviderRegistry } from "../../src/domain/foundations.js";
import { MarketplaceService } from "../../src/domain/marketplace.js";
import { SignedMockMarketplaceProvider } from "../../src/domain/signed-mock-marketplace-provider.js";
import { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository } from "../../src/domain/repository.js";

const secret = "integration-provider-secret";
const connection = {
  id: "00000000-0000-4000-8000-000000000031",
  name: "Signed test catalog",
  slug: "signed-test",
  providerSlug: "mock-signed",
  connectionMode: "mock" as const,
  status: "active" as const,
  enabled: true,
  configuration: {},
  healthStatus: "healthy" as const,
  healthMetadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

async function buildHarness() {
  const registry = new MarketplaceProviderRegistry();
  registry.register(new SignedMockMarketplaceProvider(secret));
  const connections = new InMemoryMarketplaceConnectionRepository();
  await connections.save(connection);
  const accounts = new InMemoryAffiliateAccountRepository();
  await accounts.save({
    id: "00000000-0000-4000-8000-000000000041",
    marketplaceId: connection.id,
    name: "Signed test account",
    status: "active",
    configuration: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  const services = createInMemoryServices();
  services.marketplace = new MarketplaceService(
    registry,
    connections,
    new InMemoryProductCatalogRepository(),
    accounts,
    new InMemoryAffiliateOfferRepository()
  );
  const events = new Map<string, number>();
  const providerEvents = {
    async insertIfNew(event: { externalEventId: string }) {
      if (events.has(event.externalEventId)) return false;
      events.set(event.externalEventId, 1);
      return true;
    }
  } as any;
  return { app: createApp(services, { providerEvents }), events };
}

function signedHeaders(body: string, nowMs = Date.now()) {
  const timestamp = Math.floor(nowMs / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "content-type": "application/json", "x-provider-timestamp": timestamp, "x-provider-signature": `v1=${signature}` };
}

test("accepts a valid signed provider event and deduplicates retries", async () => {
  const { app } = await buildHarness();
  const body = JSON.stringify({ id: "evt_100", type: "conversion.created", order_id: "order-1" });
  const headers = signedHeaders(body);
  const first = await app.inject({ method: "POST", url: "/api/v1/marketplaces/signed-test/events", headers, payload: body });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().duplicate, false);
  const second = await app.inject({ method: "POST", url: "/api/v1/marketplaces/signed-test/events", headers, payload: body });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  await app.close();
});

test("rejects tampered provider event bodies", async () => {
  const { app } = await buildHarness();
  const signedBody = JSON.stringify({ id: "evt_101", type: "conversion.created" });
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/signed-test/events", headers: signedHeaders(signedBody), payload: JSON.stringify({ id: "evt_101", type: "conversion.created", amount: 999 }) });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "INVALID_PROVIDER_SIGNATURE");
  await app.close();
});

test("rejects expired provider signatures", async () => {
  const { app } = await buildHarness();
  const body = JSON.stringify({ id: "evt_102", type: "conversion.created" });
  const headers = signedHeaders(body, Date.now() - 6 * 60 * 1000);
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/signed-test/events", headers, payload: body });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("rejects event ingestion for an unknown connection", async () => {
  const { app } = await buildHarness();
  const body = JSON.stringify({ id: "evt_103", type: "conversion.created" });
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/unknown/events", headers: signedHeaders(body), payload: body });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "MARKETPLACE_NOT_CONFIGURED");
  await app.close();
});

test("rejects unsigned provider events", async () => {
  const { app } = await buildHarness();
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/signed-test/events", payload: JSON.stringify({ id: "evt_104", type: "conversion.created" }) });
  assert.equal(response.statusCode, 401);
  await app.close();
});
