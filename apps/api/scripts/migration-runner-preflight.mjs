export function assertMigrationRole({
  roleName,
  roleIsSuperuser,
  roleBypassRls,
  ledgerOwner,
  hasOwnerPrivileges,
  ledgerForceRls
}) {
  if (!roleName || !ledgerOwner) {
    throw new Error("The private Drizzle migration ledger was not found; refusing to run migrations.");
  }

  if (!roleIsSuperuser && !hasOwnerPrivileges) {
    throw new Error(
      `MIGRATION_DATABASE_URL must use a superuser or a role with owner privileges on drizzle.__drizzle_migrations (connected as ${roleName}; owner is ${ledgerOwner}).`
    );
  }

  if (ledgerForceRls && !roleIsSuperuser && !roleBypassRls) {
    throw new Error(
      "The migration role cannot bypass FORCE ROW LEVEL SECURITY on drizzle.__drizzle_migrations; refusing to run migrations."
    );
  }
}
