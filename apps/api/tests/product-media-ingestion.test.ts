import assert from "node:assert/strict";
import test from "node:test";
import { ProductMediaIngestionService } from "../src/domain/product-media-ingestion.js";
import { DrizzleProductMediaAssetRepository } from "../src/db/product-media-asset-repository.js";

const productId = "462d1fd3-46d4-4832-a812-0b538ebd8144";

test("does not ingest media before non-media affiliate eligibility passes", async () => {
  let listed = 0;
  let fetched = 0;
  const storage = { upload: async () => { throw new Error("must not upload"); } } as never;
  const repository = {
    listByProduct: async () => { listed++; return []; },
    findByProductAndHash: async () => undefined,
    save: async () => { throw new Error("must not save"); }
  } as never;
  const fetcher = (async () => { fetched++; throw new Error("must not fetch"); }) as never;
  const service = new ProductMediaIngestionService(storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 }, fetcher);
  await assert.rejects(() => service.ingest({
    productId,
    nonMediaEligibilityPassed: false,
    candidates: [{ kind: "image", url: "https://cdn.example.com/image.png", source: "og" }]
  }), /must pass non-media affiliate eligibility/);
  assert.equal(listed, 0);
  assert.equal(fetched, 0);
});

test("returns an empty result without creating content when no media candidates exist", async () => {
  const repository = { listByProduct: async () => [], findByProductAndHash: async () => undefined, save: async (asset: unknown) => asset } as never;
  const storage = { upload: async () => { throw new Error("no upload expected"); } } as never;
  const service = new ProductMediaIngestionService(storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 });
  const result = await service.ingest({ productId, nonMediaEligibilityPassed: true, candidates: [] });
  assert.deepEqual(result, { stored: [], skipped: [] });
});

test("ingests a valid product video without requiring a product image", async () => {
  // Minimal structurally valid ISO-BMFF: an ftyp box followed by a non-empty mdat box.
  const bytes = Uint8Array.from([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1
  ]);
  const uploads: Array<{ key: string; contentType: string }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const storage = {
    upload: async (input: { key: string; contentType: string }) => {
      uploads.push({ key: input.key, contentType: input.contentType });
      return { bucket: "affiliate-media", key: input.key };
    },
    remove: async () => {}
  } as never;
  const repository = {
    listByProduct: async () => [],
    findByProductAndHash: async () => undefined,
    save: async (asset: Record<string, unknown>) => { saved.push(asset); return asset; }
  } as never;
  const fetcher = (async () => ({ status: 200, headers: {}, url: "https://cdn.example.com/product.mp4", bytes })) as never;
  const service = new ProductMediaIngestionService(
    storage,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    fetcher
  );

  const result = await service.ingest({
    productId,
    nonMediaEligibilityPassed: true,
    candidates: [{ kind: "video", url: "https://cdn.example.com/product.mp4", source: "og" }]
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0]?.kind, "video");
  assert.equal(result.stored[0]?.mimeType, "video/mp4");
  assert.equal(result.skipped.length, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.contentType, "video/mp4");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.rightsStatus, "unverified");
  assert.equal(saved[0]?.rightsBasis, null);
  assert.equal(saved[0]?.rightsEvidenceUrl, null);
});


test("concurrent duplicate ingestion cannot remove the object stored by the winning insert", async () => {
  const bytes = Uint8Array.from([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1
  ]);
  const uploads: string[] = [];
  const removed: string[] = [];
  const saved: Array<Record<string, unknown>> = [];
  let findCount = 0;
  let releaseFinds!: () => void;
  const bothFinds = new Promise<void>((resolve) => { releaseFinds = resolve; });
  const storage = {
    upload: async (input: { key: string }) => {
      uploads.push(input.key);
      return { bucket: "affiliate-media", key: input.key };
    },
    remove: async (key: string) => { removed.push(key); }
  } as never;
  const repository = {
    listByProduct: async () => [],
    findByProductAndHash: async () => {
      findCount += 1;
      if (findCount === 2) releaseFinds();
      await bothFinds;
      return undefined;
    },
    save: async (asset: Record<string, unknown>) => {
      const existing = saved.find((item) => item.sha256 === asset.sha256);
      if (existing) return existing;
      saved.push(asset);
      return asset;
    }
  } as never;
  const fetcher = (async () => ({ status: 200, headers: {}, url: "https://cdn.example.com/product.mp4", bytes })) as never;
  const makeService = () => new ProductMediaIngestionService(
    storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 }, fetcher
  );
  const input = {
    productId, nonMediaEligibilityPassed: true,
    candidates: [{ kind: "video" as const, url: "https://cdn.example.com/product.mp4", source: "catalog" as const }]
  };

  const results = await Promise.all([makeService().ingest(input), makeService().ingest(input)]);
  assert.equal(results.filter((result) => result.stored.length === 1).length, 2);
  assert.equal(results[0]?.stored[0]?.objectKey, results[1]?.stored[0]?.objectKey);
  assert.equal(uploads.length, 2);
  assert.notEqual(uploads[0], uploads[1]);
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], saved[0]?.objectKey);
  assert.equal(saved.length, 1);
});


const reviewAsset = (overrides: Record<string, unknown> = {}) => ({
  id: "7f1c4c8d-7a2f-4e61-8b0d-1dcb3b48c001",
  productId,
  kind: "image",
  bucket: "affiliate-media",
  objectKey: `products/${productId}/asset.jpg`,
  mimeType: "image/jpeg",
  byteSize: 128,
  sha256: "d".repeat(64),
  sourceUrl: "https://cdn.example.com/product.jpg",
  sourcePublisher: null,
  rightsStatus: "unverified",
  rightsBasis: null,
  rightsEvidenceUrl: null,
  rightsVerifiedAt: null,
  createdAt: "2026-11-03T00:00:00.000Z",
  ...overrides
});

const makeRightsReviewRepository = (initial: ReturnType<typeof reviewAsset> | undefined, failAuditInsert = false) => {
  let asset = initial ? structuredClone(initial) : undefined;
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => asset ? [structuredClone(asset)] : []
          })
        })
      })
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (!asset) return [];
            asset = { ...asset, ...values };
            return [structuredClone(asset)];
          }
        })
      })
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (failAuditInsert) throw new Error("injected audit insert failure");
        audits.push(structuredClone(row));
      }
    })
  };
  const db = {
    transaction: async (work: (executor: typeof tx) => Promise<unknown>) => {
      const beforeAsset = asset ? structuredClone(asset) : undefined;
      const beforeAuditCount = audits.length;
      try {
        return await work(tx);
      } catch (error) {
        asset = beforeAsset;
        audits.splice(beforeAuditCount);
        throw error;
      }
    }
  };
  return {
    repository: new DrizzleProductMediaAssetRepository(db as never),
    snapshot: () => ({ asset: asset ? structuredClone(asset) : undefined, audits: structuredClone(audits) })
  };
};

test("rights verification atomically updates the asset and appends one provenance audit", async () => {
  const fixture = makeRightsReviewRepository(reviewAsset());
  const reviewed = await fixture.repository.reviewRights(reviewAsset().id, productId, {
    status: "verified",
    rightsBasis: "explicit_permission",
    rightsEvidenceUrl: "https://example.com/permission",
    sourcePublisher: "Product owner",
    actorId: "admin-42",
    actorRole: "admin",
    reason: "Written permission checked"
  });

  const snapshot = fixture.snapshot();
  assert.equal(reviewed?.rightsStatus, "verified");
  assert.equal(snapshot.asset?.rightsStatus, "verified");
  assert.equal(snapshot.audits.length, 1);
  assert.equal(snapshot.audits[0]?.actorId, "admin-42");
  assert.equal(snapshot.audits[0]?.actorRole, "admin");
  assert.equal(snapshot.audits[0]?.action, "verify");
  assert.equal(snapshot.audits[0]?.reason, "Written permission checked");
  assert.equal(snapshot.audits[0]?.previousRightsStatus, "unverified");
  assert.equal(snapshot.audits[0]?.newRightsStatus, "verified");
  assert.equal(snapshot.audits[0]?.rightsBasis, "explicit_permission");
  assert.equal(snapshot.audits[0]?.rightsEvidenceUrl, "https://example.com/permission");
  assert.equal(snapshot.audits[0]?.sourcePublisher, "Product owner");
});

test("audit insert failure rolls back the product media rights update", async () => {
  const original = reviewAsset();
  const fixture = makeRightsReviewRepository(original, true);
  await assert.rejects(() => fixture.repository.reviewRights(original.id, productId, {
    status: "verified",
    rightsBasis: "license",
    rightsEvidenceUrl: "https://example.com/license",
    actorId: "admin-42",
    actorRole: "admin",
    reason: "License checked"
  }), /injected audit insert failure/);

  const snapshot = fixture.snapshot();
  assert.deepEqual(snapshot.asset, original);
  assert.equal(snapshot.audits.length, 0);
});

test("revoking rights preserves the original evidence and publisher in asset and audit snapshot", async () => {
  const original = reviewAsset({
    rightsStatus: "verified",
    rightsBasis: "license",
    rightsEvidenceUrl: "https://example.com/license",
    rightsVerifiedAt: "2026-11-02T12:00:00.000Z",
    sourcePublisher: "Licensed publisher"
  });
  const fixture = makeRightsReviewRepository(original);
  await fixture.repository.reviewRights(original.id, productId, {
    status: "revoked",
    actorId: "admin-77",
    actorRole: "admin",
    reason: "Permission withdrawn"
  });

  const snapshot = fixture.snapshot();
  assert.equal(snapshot.asset?.rightsStatus, "revoked");
  assert.equal(snapshot.asset?.rightsBasis, original.rightsBasis);
  assert.equal(snapshot.asset?.rightsEvidenceUrl, original.rightsEvidenceUrl);
  assert.equal(snapshot.asset?.rightsVerifiedAt, original.rightsVerifiedAt);
  assert.equal(snapshot.asset?.sourcePublisher, original.sourcePublisher);
  assert.equal(snapshot.audits.length, 1);
  assert.equal(snapshot.audits[0]?.action, "revoke");
  assert.equal(snapshot.audits[0]?.previousRightsStatus, "verified");
  assert.equal(snapshot.audits[0]?.newRightsStatus, "revoked");
  assert.equal(snapshot.audits[0]?.rightsBasis, original.rightsBasis);
  assert.equal(snapshot.audits[0]?.rightsEvidenceUrl, original.rightsEvidenceUrl);
  assert.equal(snapshot.audits[0]?.sourcePublisher, original.sourcePublisher);
});

test("a product mismatch leaves the media asset and rights audit untouched", async () => {
  const fixture = makeRightsReviewRepository(undefined);
  const reviewed = await fixture.repository.reviewRights(reviewAsset().id, productId, {
    status: "verified",
    rightsBasis: "user_owned",
    actorId: "admin-42",
    actorRole: "admin",
    reason: "Mismatch probe"
  });
  assert.equal(reviewed, undefined);
  assert.deepEqual(fixture.snapshot(), { asset: undefined, audits: [] });
});
