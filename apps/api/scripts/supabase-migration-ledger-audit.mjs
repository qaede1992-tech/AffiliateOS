/**
 * Read-only diagnostics for Supabase's migration ledger.
 * Names may be repeated across distinct versions; report them without mutating
 * history or treating a repeated name alone as proof that schema changes failed.
 */
export function findDuplicateSupabaseMigrationNames(rows) {
  const versionsByName = new Map();
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const version = typeof row.version === "string" ? row.version : String(row.version ?? "");
    const versions = versionsByName.get(name) ?? [];
    versions.push(version);
    versionsByName.set(name, versions);
  }
  return [...versionsByName.entries()]
    .filter(([, versions]) => versions.length > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
