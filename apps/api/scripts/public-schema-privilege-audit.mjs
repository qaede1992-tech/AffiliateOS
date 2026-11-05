const PUBLIC_SCHEMA = "public";
const GLOBAL_SCHEMA = "<global>";
const PUBLIC_GRANTEES = new Set(["anon", "authenticated", "PUBLIC"]);

// PostgreSQL's built-in default for new functions includes EXECUTE for PUBLIC.
// pg_default_acl stores only explicit overrides, so include acldefault() when a
// creator role has no global function-default override. Per-schema defaults are
// additive and therefore do not cancel the built-in PUBLIC grant.
export const PUBLIC_SCHEMA_DEFAULT_ACL_QUERY = `
  WITH explicit_defaults AS (
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
    WHERE d.defaclnamespace = 0 OR n.nspname = 'public'
  ),
  implicit_function_defaults AS (
    SELECT '<global>' AS schema_name,
           owner.rolname AS creator_role,
           'f' AS object_type,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type
    FROM pg_roles owner
    CROSS JOIN LATERAL aclexplode(acldefault('f', owner.oid)) AS acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE has_schema_privilege(owner.oid, 'public', 'CREATE')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_default_acl global_defaults
        WHERE global_defaults.defaclrole = owner.oid
          AND global_defaults.defaclobjtype = 'f'
          AND global_defaults.defaclnamespace = 0
      )
  )
  SELECT DISTINCT schema_name, creator_role, object_type, grantee, privilege_type
  FROM (
    SELECT * FROM explicit_defaults
    UNION ALL
    SELECT * FROM implicit_function_defaults
  ) defaults
  ORDER BY schema_name, creator_role, object_type, grantee, privilege_type
`;

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
