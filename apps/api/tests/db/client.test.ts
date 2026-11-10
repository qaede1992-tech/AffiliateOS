import assert from "node:assert/strict";
import test from "node:test";
import { createDatabasePersistence } from "../../src/db/client.js";

test("configures the intended idle timeout for the Supavisor pool", async () => {
  const persistence = createDatabasePersistence("postgres://localhost/affiliateos");

  try {
    assert.equal(persistence.pool.options.idleTimeoutMillis, 120_000);
  } finally {
    await persistence.close();
  }
});
