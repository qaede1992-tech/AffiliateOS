import assert from "node:assert/strict";
import test from "node:test";
import { findPublicSchemaDefaultAclGrants } from "../scripts/public-schema-privilege-audit.mjs";

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
