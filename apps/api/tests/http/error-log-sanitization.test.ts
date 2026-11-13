import assert from "node:assert/strict";
import test from "node:test";
import { safeHttpErrorLogFields } from "../../src/app.js";

test("HTTP error log fields retain only a validated error type", () => {
  const error = new Error("Failed query: SELECT * FROM private_table WHERE id = $1; params: private-marker");
  error.name = "DatabaseError";

  const fields = safeHttpErrorLogFields(error);

  assert.deepEqual(fields, { errorType: "DatabaseError" });
  assert.doesNotMatch(JSON.stringify(fields), /SELECT|params:|private-marker/i);
});

test("HTTP error log fields reject unsafe error names and non-Error values", () => {
  const error = new Error("private database details");
  error.name = "Error; SELECT * FROM secrets";

  assert.deepEqual(safeHttpErrorLogFields(error), { errorType: "UnknownError" });
  assert.deepEqual(safeHttpErrorLogFields("Failed query: SELECT * FROM secrets; params: private-marker"), {
    errorType: "UnknownError"
  });
});
