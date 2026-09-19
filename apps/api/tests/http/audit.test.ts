import assert from "node:assert/strict";
import test from "node:test";
import { auditSecurityEvent } from "../../src/http/app-audit.js";

test("security audit events are structured without credential fields", () => {
  const entries: Array<{ payload: Record<string, unknown>; message: string }> = [];
  const log = {
    warn(payload: Record<string, unknown>, message: string) {
      entries.push({ payload, message });
    }
  } as never;
  const request = { id: "req-123", auth: { operatorId: "operator-test", role: "operator" } } as never;

  auditSecurityEvent(log, request, "authorization_denied", { requiredRole: "operator" });

  assert.deepEqual(entries, [
    {
      payload: {
        event: "authorization_denied",
        requestId: "req-123",
        operatorId: "operator-test",
        role: "operator",
        requiredRole: "operator"
      },
      message: "security_audit:authorization_denied"
    }
  ]);
  assert.equal("token" in entries[0].payload, false);
  assert.equal("authorization" in entries[0].payload, false);
});
