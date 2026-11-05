const PUBLIC_SCHEMA = "public";
const GLOBAL_SCHEMA = "<global>";
const PUBLIC_GRANTEES = new Set(["anon", "authenticated", "PUBLIC"]);

export function findPublicSchemaDefaultAclGrants(rows) {
  return rows
    .map((row) => {
      const rawSchema = row?.schema_name ?? row?.schemaName;
      const schemaName = typeof rawSchema === "string" && rawSchema.trim()
        ? rawSchema.trim()
        : GLOBAL_SCHEMA;
      const rawGrantee = row?.grantee;
      const grantee = typeof rawGrantee === "string" && rawGrantee.trim()
        ? rawGrantee.trim()
        : "PUBLIC";

      return {
        schemaName,
        creatorRole: String(row?.creator_role ?? row?.owner_role ?? "unknown"),
        objectType: String(row?.object_type ?? ""),
        grantee,
        privilegeType: String(row?.privilege_type ?? "")
      };
    })
    .filter((finding) =>
      (finding.schemaName === PUBLIC_SCHEMA || finding.schemaName === GLOBAL_SCHEMA) &&
      PUBLIC_GRANTEES.has(finding.grantee)
    )
    .sort((left, right) =>
      left.schemaName.localeCompare(right.schemaName) ||
      left.creatorRole.localeCompare(right.creatorRole) ||
      left.objectType.localeCompare(right.objectType) ||
      left.grantee.localeCompare(right.grantee) ||
      left.privilegeType.localeCompare(right.privilegeType)
    );
}
