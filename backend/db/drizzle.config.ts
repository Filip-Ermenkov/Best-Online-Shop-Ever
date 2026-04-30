import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration.
 *
 * Workflow:
 *   1. Edit a schema file in src/schema/*.ts
 *   2. Run `npm run db:generate` — emits SQL to drizzle/ and a snapshot to drizzle/meta/
 *   3. Review the SQL diff, commit both the schema change AND the generated migration
 *   4. Run `npm run db:migrate` to apply pending migrations to the target database
 *
 * NEVER run `drizzle-kit push` against staging or production. `push` mutates the database
 * directly without producing a migration file and will silently misinterpret renames as
 * drop-then-add (data loss). It is acceptable on a throwaway local DB only.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://shop:shop@localhost:5432/shop",
  },
  // Verbose output is on by default; this just makes the snapshot diff readable.
  verbose: true,
  strict: true,
});
