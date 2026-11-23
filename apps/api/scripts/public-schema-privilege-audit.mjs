const PUBLIC_SCHEMA = "public";
const GLOBAL_SCHEMA = "<global>";
const PUBLIC_GRANTEES = new Set(["anon", "authenticated", "PUBLIC"]);

// Evaluate only the role that will create objects during this migration run.
// Supabase's internal supabase_admin defaults do not apply to objects created
// by the migration connection's current_user.
export const PUBLIC_SCHEMA_DEFAULT_ACL_QUERY = `
  SELECT COALESCE(n.nspname, '<global>') AS schema_name,
         owner.rolname AS creator_role,
         d.defaclobjtype::text AS object_type,
         COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
         acl.privilege_type
  FROM pg_default_acl d
  JOIN pg_roles owner ON owner.oid = d.defaclrole
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE (d.defaclnamespace = 0 OR n.nspname = 'public')
    AND owner.rolname = current_user
  ORDER BY schema_name, creator_role, object_type, grantee, privilege_type
`;

// PostgreSQL's built-in default grants EXECUTE on new functions to PUBLIC.
// Check that implicit default only when a pending migration creates a
// function or procedure; table/sequence migrations do not inherit this grant.
export const PUBLIC_SCHEMA_IMPLICIT_FUNCTION_DEFAULT_ACL_QUERY = `
  SELECT '<global>' AS schema_name,
         owner.rolname AS creator_role,
         'f' AS object_type,
         COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
         acl.privilege_type
  FROM pg_roles owner
  CROSS JOIN LATERAL aclexplode(acldefault('f', owner.oid)) AS acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE owner.rolname = current_user
    AND has_schema_privilege(owner.oid, 'public', 'CREATE')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_default_acl global_defaults
      WHERE global_defaults.defaclrole = owner.oid
        AND global_defaults.defaclobjtype = 'f'
        AND global_defaults.defaclnamespace = 0
    )
`;

export function migrationCreatesFunctionOrProcedure(sqlText) {
  return /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(sqlText);
}

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
