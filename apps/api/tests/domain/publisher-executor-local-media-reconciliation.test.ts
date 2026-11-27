import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, SocialAccount } from "@affiliateos/shared";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import type { MediaAsset, MediaAssetRepository } from "../../src/domain/media-asset.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";
import type { SocialAccountRepository, ContentProductRepository } from "../../src/domain/repository.js";
import type { PublicationOperation } from "../../src/domain/publication-operation.js";
import type { ContentService } from "../../src/domain/content.js";

const contentId = "33333333-3333-4333-8333-333333333333";
const productId = "22222222-2222-4222-8222-222222222222";
const mediaId = "11111111-1111-4111-8111-111111111111";
const productMediaId = "88888888-8888-4888-8888-888888888888";
const accountId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-11-27T00:00:00.000Z";

describe("PublisherExecutor local media reconciliation", () => {
  it("checks Instagram publication using local media metadata without minting a dispatch URL", async () => {
    const content = {
      id: contentId, productId, platform: "instagram", contentType: "affiliate-promotion",
      status: "scheduled", scheduledAt: timestamp, caption: "Product demo",
      mediaAssetIds: [mediaId], socialAccountId: accountId,
      createdAt: timestamp, updatedAt: timestamp
    } as Content;
    const account: SocialAccount = {
      id: accountId, platform: "instagram", accountReference: "instagram-ref",
      status: "active", connection: {}, createdAt: timestamp, updatedAt: timestamp
    };
    const media: MediaAsset = {
      id: mediaId, contentId, kind: "video", source: "object-storage",
      reference: `local-volume/products/${productId}/media.mp4`,
      mimeType: "video/mp4", byteSize: 4, createdAt: timestamp, updatedAt: timestamp
    };
    const productMedia: ProductMediaAsset = {
      id: productMediaId, productId, kind: "video", bucket: "local-volume", storageBackend: "local_volume",
      objectKey: `products/${productId}/media.mp4`, mimeType: "video/mp4", byteSize: 4,
      sha256: "a".repeat(64), sourceUrl: "https://media.example/source.mp4",
      sourcePublisher: "Example publisher", rightsStatus: "verified", rightsBasis: "license",
      rightsEvidenceUrl: "https://media.example/license", rightsVerifiedAt: timestamp,
      identityStatus: "verified", identityReviewedBy: "admin-1", identityReviewedAt: timestamp,
      identityReviewReason: "The product identity was independently reviewed.", createdAt: timestamp
    };

    const contentService = {
      get: async () => content,
      validatePublicationEligibility: async () => undefined
    } as unknown as ContentService;
    const socialAccounts = {
      list: async () => [account]
    } as unknown as SocialAccountRepository;
    const mediaAssets = {
      findById: async (id: string) => id === mediaId ? media : undefined
    } as unknown as MediaAssetRepository;
    const contentProducts = {
      listByContent: async () => []
    } as unknown as ContentProductRepository;
    const productMediaAssets = {
      listByProduct: async (id: string) => id === productId ? [productMedia] : []
    } as unknown as ProductMediaAssetRepository;

    let checkedAssets: MediaAsset[] | undefined;
    const publisher: SocialPublisher = {
      provider: "instagram-graph",
      supports: (platform) => platform === "instagram",
      publish: async () => ({ status: "accepted", providerOperationId: "container-1" }),
      checkPublication: async ({ mediaAssets: assets }) => {
        checkedAssets = assets;
        return { status: "processing" };
      }
    };
    const executor = new PublisherExecutor(
      contentService, socialAccounts, [publisher], undefined, mediaAssets,
      undefined, undefined, undefined, contentProducts, productMediaAssets
    );
    const operation: PublicationOperation = {
      id: "66666666-6666-4666-8666-666666666666", contentId,
      jobId: "77777777-7777-4777-8777-777777777777", provider: "instagram-graph",
      providerOperationId: "container-1", status: "accepted",
      createdAt: timestamp, updatedAt: timestamp
    };

    const result = await executor.check(operation);
    assert.equal(result.result.status, "processing");
    assert.equal(checkedAssets?.length, 1);
    assert.equal(checkedAssets?.[0]?.kind, "video");
    assert.equal(checkedAssets?.[0]?.source, "object-storage");
    assert.equal(checkedAssets?.[0]?.reference, media.reference);
  });
});
