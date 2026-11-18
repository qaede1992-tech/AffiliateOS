import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import test from "node:test";
import { DrizzlePublicationDispatchReservationRepository } from "../src/db/publication-dispatch-reservation-repository.js";

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL reservation insert and state transition are safe under concurrent workers", {
  skip: !databaseUrl,
  timeout: 30_000
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle(pool);
  const repository = new DrizzlePublicationDispatchReservationRepository(db);
  const contentId = randomUUID();
  const jobId = randomUUID();
  const timestamp = new Date().toISOString();
  const provider = "instagram-graph";
  const idempotencyKey = `postgres-concurrency:${randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO public.content
        (id, platform, content_type, status, created_at, updated_at)
       VALUES ($1, 'instagram', 'image', 'scheduled', $2, $2)`,
      [contentId, timestamp]
    );
    await pool.query(
      `INSERT INTO public.publication_jobs
        (id, content_id, idempotency_key, status, attempt_count, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'processing', 1, $4, $4, $4)`,
      [jobId, contentId, idempotencyKey, timestamp]
    );

    const makeReservation = (id: string) => ({
      id,
      jobId,
      contentId,
      provider,
      state: "reserved" as const,
      idempotencyKey,
      snapshot: { contentId, mediaAssetIds: ["asset-stable-id"] },
      snapshotHash: "a".repeat(64),
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const proposals = [makeReservation(randomUUID()), makeReservation(randomUUID())];
    const inserted = await Promise.all(proposals.map((proposal) => repository.reserve(proposal)));

    assert.equal(inserted[0]?.id, inserted[1]?.id, "both workers must observe the same durable reservation");
    assert.equal(inserted[0]?.jobId, jobId);
    assert.equal(inserted[0]?.provider, provider);

    const current = inserted[0]!;
    const transitionTime = new Date(Date.now() + 1).toISOString();
    const transitions = await Promise.all([
      repository.transition(current.id, ["reserved"], {
        ...current, state: "dispatching", dispatchStartedAt: transitionTime, updatedAt: transitionTime
      }),
      repository.transition(current.id, ["reserved"], {
        ...current, state: "safe_to_retry", resolvedAt: transitionTime, updatedAt: transitionTime
      })
    ]);

    assert.equal(transitions.filter(Boolean).length, 1, "only one competing conditional UPDATE may win");
    const persisted = await repository.findByJobProvider(jobId, provider);
    assert.ok(persisted);
    assert.ok(["dispatching", "safe_to_retry"].includes(persisted.state));
  } finally {
    await pool.query("DELETE FROM public.publication_dispatch_reservations WHERE job_id = $1", [jobId]);
    await pool.query("DELETE FROM public.publication_jobs WHERE id = $1", [jobId]);
    await pool.query("DELETE FROM public.content WHERE id = $1", [contentId]);
    await pool.end();
  }
});
