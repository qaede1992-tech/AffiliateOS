import { defineConfig } from "drizzle-kit";

// Runtime queries use DATABASE_URL. Schema migrations may use a separate,
// tightly controlled owner connection supplied only to deployment tooling.
// The fallback keeps local development and existing CI environments working.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/autonomous-optimization-state.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? ""
  }
});
