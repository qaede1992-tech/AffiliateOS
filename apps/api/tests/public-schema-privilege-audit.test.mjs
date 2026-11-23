import assert from "node:assert/strict";
import test from "node:test";
import {
  findPublicSchemaDefaultAclGrants,
  migrationCreatesFunctionOrProcedure,
  PUBLIC_SCHEMA_DEFAULT_ACL_QUERY,
  MIGRATION_ROLE_DEFAULT_ACL_QUERY,
  MIGRATION_ROLE_IMPLICIT_FUNCTION_DEFAULT_ACL_QUERY
} from "../scripts/public-schema-privilege-audit.mjs";

test("detects anon and authenticated defaults from any creator role", () => {
  const findings = findPublicSchemaDefaultAclGrants([
    { schema_name: "public", creator_role: "supabase_admin", object_type: "r", grantee: "anon", privilege_type: "SELECT" },
    { schema_name: "public", creator_role: "supabase_admin", object_type: "S", grantee: "authenticated", privilege_type: "USAGE" },
    { schema_name: "public", creator_role: "postgres", object_type: "r", grantee: "affiliateos_runtime", privilege_type: "SELECT" }
  ]);

  assert.deepEqual(findings, [
    { schemaName: "public", creatorRole: "supabase_admin", objectType: "r", grantee: "anon", privilegeType: "SELECT" },
    { schemaName: "public", creatorRole: "supabase_admin", objectType: "S", grantee: "authenticated", privilegeType: "USAGE" }
  ]);
});

test("detects global defaults and explicit PUBLIC grants", () => {
  const findings = findPublicSchemaDefaultAclGrants([
    { schema_name: "<global>", creator_role: "supabase_admin", object_type: "S", grantee: "authenticated", privilege_type: "SELECT" },
    { schema_name: "public", creator_role: "supabase_admin", object_type: "r", grantee: "PUBLIC", privilege_type: "INSERT" },
    { schema_name: "private", creator_role: "supabase_admin", object_type: "r", grantee: "anon", privilege_type: "SELECT" }
  ]);

  assert.deepEqual(findings, [
    { schemaName: "<global>", creatorRole: "supabase_admin", objectType: "S", grantee: "authenticated", privilegeType: "SELECT" },
    { schemaName: "public", creatorRole: "supabase_admin", objectType: "r", grantee: "PUBLIC", privilegeType: "INSERT" }
  ]);
});

test("detects implicit PostgreSQL function defaults granted to PUBLIC", () => {
  assert.deepEqual(findPublicSchemaDefaultAclGrants([
    {
      schema_name: "<global>",
      creator_role: "affiliateos_implicit_function_creator",
      object_type: "f",
      grantee: "PUBLIC",
      privilege_type: "EXECUTE"
    }
  ]), [
    {
      schemaName: "<global>",
      creatorRole: "affiliateos_implicit_function_creator",
      objectType: "f",
      grantee: "PUBLIC",
      privilegeType: "EXECUTE"
    }
  ]);
});

test("treats null schema and grantee as global schema and PUBLIC", () => {
  assert.deepEqual(findPublicSchemaDefaultAclGrants([
    { schema_name: null, creator_role: "postgres", object_type: "f", grantee: null, privilege_type: "EXECUTE" }
  ]), [
    { schemaName: "<global>", creatorRole: "postgres", objectType: "f", grantee: "PUBLIC", privilegeType: "EXECUTE" }
  ]);
});

test("ignores non-public namespaces and least-privilege runtime defaults", () => {
  assert.deepEqual(findPublicSchemaDefaultAclGrants([
    { schema_name: "private", creator_role: "supabase_admin", object_type: "r", grantee: "authenticated", privilege_type: "SELECT" },
    { schema_name: "public", creator_role: "postgres", object_type: "r", grantee: "affiliateos_runtime", privilege_type: "INSERT" }
  ]), []);
});

test("scopes explicit default ACL query to the migration connection role", () => {
  assert.match(MIGRATION_ROLE_DEFAULT_ACL_QUERY, /owner\.rolname = current_user/);
  assert.match(PUBLIC_SCHEMA_DEFAULT_ACL_QUERY, /implicit_function_defaults/);
});

test("checks PostgreSQL implicit function defaults only for pending callable migrations", () => {
  assert.match(MIGRATION_ROLE_IMPLICIT_FUNCTION_DEFAULT_ACL_QUERY, /owner\.rolname = current_user/);
  assert.equal(migrationCreatesFunctionOrProcedure("CREATE FUNCTION public.example() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;"), true);
  assert.equal(migrationCreatesFunctionOrProcedure("CREATE OR REPLACE PROCEDURE public.example() LANGUAGE sql AS $$ SELECT 1 $$;"), true);
  assert.equal(migrationCreatesFunctionOrProcedure("CREATE TABLE public.example (id uuid PRIMARY KEY);"), false);
  assert.equal(migrationCreatesFunctionOrProcedure("ALTER TABLE public.example ADD COLUMN name text;"), false);
});
