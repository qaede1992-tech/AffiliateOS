import assert from "node:assert/strict";
import test from "node:test";
import { assertMigrationRole } from "../scripts/migration-runner-preflight.mjs";

const ownerRole = {
  roleName: "postgres",
  roleIsSuperuser: false,
  roleBypassRls: false,
  ledgerOwner: "postgres",
  hasOwnerPrivileges: true,
  ledgerForceRls: false
};

test("migration preflight accepts the ledger owner when FORCE RLS is disabled", () => {
  assert.doesNotThrow(() => assertMigrationRole(ownerRole));
});

test("migration preflight accepts a superuser even when it is not the ledger owner", () => {
  assert.doesNotThrow(() => assertMigrationRole({
    ...ownerRole,
    roleName: "migration_admin",
    roleIsSuperuser: true,
    hasOwnerPrivileges: false,
    ledgerOwner: "postgres",
    ledgerForceRls: true
  }));
});

test("migration preflight rejects a non-owner runtime role before migrations run", () => {
  assert.throws(
    () => assertMigrationRole({
      ...ownerRole,
      roleName: "affiliateos_runtime",
      hasOwnerPrivileges: false
    }),
    /superuser or a role with owner privileges/
  );
});

test("migration preflight rejects FORCE RLS when the migration role cannot bypass it", () => {
  assert.throws(
    () => assertMigrationRole({
      ...ownerRole,
      ledgerForceRls: true
    }),
    /cannot bypass FORCE ROW LEVEL SECURITY/
  );
});

test("migration preflight accepts FORCE RLS only when the migration role can bypass it", () => {
  assert.doesNotThrow(() => assertMigrationRole({
    ...ownerRole,
    ledgerForceRls: true,
    roleBypassRls: true
  }));
});

test("migration preflight rejects a missing ledger", () => {
  assert.throws(
    () => assertMigrationRole({ ...ownerRole, ledgerOwner: null }),
    /ledger was not found/
  );
});
