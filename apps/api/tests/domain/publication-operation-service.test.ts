import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicationOperationService } from "../../src/domain/publication-operation-service.js";
import { InMemoryPublicationOperationRepository } from "../../src/domain/publication-operation.js";

const createInput = (provider: string, providerOperationId: string) => ({
  contentId: "content-1",
  jobId: "job-1",
  provider,
  providerOperationId
});

describe("PublicationOperationService Instagram idempotency", () => {
  it("reuses an existing non-failed Instagram operation for the same job", async () => {
    const repository = new InMemoryPublicationOperationRepository();
    const service = new PublicationOperationService(repository);
    const first = await service.create(createInput("instagram-graph", "container-1"), new Date("2026-10-29T00:00:00.000Z"));
    const retry = await service.create(createInput("instagram-graph", "container-2"), new Date("2026-10-29T00:01:00.000Z"));

    assert.equal(retry.id, first.id);
    assert.equal(retry.providerOperationId, "container-1");
    assert.equal((await repository.listByJobId("job-1")).length, 1);
  });

  it("reuses an already published Instagram operation instead of creating a second post", async () => {
    const repository = new InMemoryPublicationOperationRepository();
    const service = new PublicationOperationService(repository);
    const first = await service.create(createInput("instagram-graph", "container-1"), new Date("2026-10-29T00:00:00.000Z"));
    await service.transition(first.id, "published", { externalPostId: "instagram-post-1" }, new Date("2026-10-29T00:02:00.000Z"));
    const retry = await service.create(createInput("instagram-graph", "container-2"), new Date("2026-10-29T00:03:00.000Z"));

    assert.equal(retry.id, first.id);
    assert.equal(retry.externalPostId, "instagram-post-1");
    assert.equal((await repository.listByJobId("job-1")).length, 1);
  });

  it("allows an Instagram retry after the prior operation has failed", async () => {
    const repository = new InMemoryPublicationOperationRepository();
    const service = new PublicationOperationService(repository);
    const first = await service.create(createInput("instagram-graph", "container-1"), new Date("2026-10-29T00:00:00.000Z"));
    await service.transition(first.id, "failed", { error: "container failed" }, new Date("2026-10-29T00:00:30.000Z"));
    const retry = await service.create(createInput("instagram-graph", "container-2"), new Date("2026-10-29T00:01:00.000Z"));

    assert.notEqual(retry.id, first.id);
    assert.equal(retry.providerOperationId, "container-2");
    assert.equal((await repository.listByJobId("job-1")).length, 2);
  });

  it("recovers an Instagram operation insert race using the active-job uniqueness guard", async () => {
    const base = new InMemoryPublicationOperationRepository();
    const seedService = new PublicationOperationService(base);
    const first = await seedService.create(createInput("instagram-graph", "container-1"), new Date("2026-10-29T00:00:00.000Z"));
    let listCalls = 0;
    const racingRepository: import("../../src/domain/publication-operation.js").PublicationOperationRepository = {
      list: () => base.list(),
      listByJobId: async (jobId) => {
        listCalls += 1;
        return listCalls === 1 ? [] : base.listByJobId(jobId);
      },
      findById: (id) => base.findById(id),
      findByProviderOperation: (provider, providerOperationId) => base.findByProviderOperation(provider, providerOperationId),
      save: (operation) => base.save(operation),
      saveIfAbsent: async (operation) => {
        const existing = (await base.listByJobId(operation.jobId))
          .find((candidate) => candidate.provider === operation.provider && candidate.status !== "failed");
        if (existing) {
          const error = Object.assign(new Error("duplicate active job/provider operation"), { code: "23505" });
          throw error;
        }
        return base.saveIfAbsent(operation);
      }
    };
    const racingService = new PublicationOperationService(racingRepository);
    const retry = await racingService.create(createInput("instagram-graph", "container-2"), new Date("2026-10-29T00:01:00.000Z"));

    assert.equal(retry.id, first.id);
    assert.equal(retry.providerOperationId, "container-1");
    assert.equal((await base.listByJobId("job-1")).length, 1);
  });

  it("does not change TikTok operation behavior", async () => {
    const repository = new InMemoryPublicationOperationRepository();
    const service = new PublicationOperationService(repository);
    const first = await service.create(createInput("tiktok", "operation-1"), new Date("2026-10-29T00:00:00.000Z"));
    const second = await service.create(createInput("tiktok", "operation-2"), new Date("2026-10-29T00:01:00.000Z"));

    assert.notEqual(second.id, first.id);
    assert.equal((await repository.listByJobId("job-1")).length, 2);
  });
});
