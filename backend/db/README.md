# @shop/db

Database schema, migrations, seed, and a transport-agnostic client factory for
the shop. **Single source of truth for the data model** — every other package
imports its types and tables from here.

## Why this design

Three decisions made up front, with reasoning, so future you doesn't redebate them:

### 1. Drizzle, not Prisma

For Lambda + Neon, Drizzle has dramatically smaller bundles (~7 KB vs ~1.6 MB)
and faster cold starts (~45 ms vs ~320 ms even with Prisma 7's serverless
overhaul released late 2025). Drizzle's schema is plain TypeScript files — no
codegen step, no `.prisma` DSL. Matches our zero-build-step IaC mindset.

### 2. Two transports — Neon HTTP for production, node-postgres for local

`createDb()` picks automatically based on the URL hostname:

| Environment | Driver | Why |
|---|---|---|
| AWS Lambda → Neon | `@neondatabase/serverless` HTTP | Each query is one HTTPS round-trip. No persistent TCP. Avoids the Lambda connection-storm problem. |
| Local dev (Docker) | `pg` connection pool | Real TCP pool, identical SQL semantics, supports interactive transactions and advisory locks (which `drizzle-kit migrate` requires). |

Application code is identical across both — Drizzle's API doesn't change.

### 3. drizzle-kit `generate` + `migrate`, never `push`

`drizzle-kit push` mutates the database directly without producing a migration
file and silently misinterprets renames as drop-then-add (data loss). It's
banned from staging and production. The workflow:

```
  edit schema → npm run db:generate → review SQL diff → commit → npm run db:migrate
```

The committed `drizzle/` folder contains both the SQL migrations and the
metadata snapshot drizzle-kit uses to compute future diffs. **Both must be
checked in.**

## Local development workflow

Prerequisites: Docker Desktop, Node 20+ (we test on 22).

```bash
cd backend/db
cp .env.example .env
npm install
npm run db:up           # boots Postgres 17 in Docker on :5432
npm run db:migrate      # applies every committed migration
npm run db:seed         # populates demo data (idempotent)
```

Useful commands:

```bash
npm run db:psql         # opens psql shell in the running container
npm run db:studio       # browser UI to inspect data
npm run db:logs         # tail Postgres logs
npm run db:reset        # nuke volume + remigrate + reseed (DESTRUCTIVE)
npm run db:down         # stop the container (data persists in the volume)
```

## Adding a schema change

```bash
# 1. Edit the relevant file in src/schema/*.ts.
# 2. Generate the migration:
npm run db:generate
# 3. Review the diff that lands in drizzle/0001_xxx.sql.
#    If drizzle-kit interpreted a rename as drop+add, FIX THE SQL by hand
#    before committing — the .sql file is authoritative, the snapshot just
#    records what was applied.
# 4. Commit:
git add src/schema drizzle
git commit -m "db: add <thing>"
# 5. Apply locally to verify:
npm run db:migrate
```

### Zero-downtime migrations (production)

Follow expand-contract:

```sql
-- Step 1 (Expand) — backward compatible. Deploy with old code still running.
ALTER TABLE orders ADD COLUMN new_field TEXT;

-- Step 2 (Migrate) — backfill. Deploy code that writes to BOTH old and new.
UPDATE orders SET new_field = compute(...) WHERE new_field IS NULL;

-- Step 3 (Contract) — enforce. Deploy code that reads from new only.
ALTER TABLE orders ALTER COLUMN new_field SET NOT NULL;
ALTER TABLE orders DROP COLUMN old_field;
```

Each step is its own migration. Never combine them.

## Production deployment

Production migrations run from a **dedicated step** in the deploy pipeline, BEFORE
the application code that depends on the new schema is rolled out:

```
git push → CI build → run migrations against Neon → deploy Lambda → smoke test
```

The application Lambdas must NEVER apply migrations on cold start: that creates
race conditions when multiple cold containers come up at once and turns every
deploy into a coin flip.

## Schema map

```
enums.ts       Native Postgres enums (user_role, order_status, …)
users.ts       users · customer_profiles · corporate_profiles · addresses
               discounts · mfa_recovery_codes
catalog.ts     categories · products · product_images · banner_slides
cart.ts        carts · cart_items
orders.ts      orders · order_items · order_corporate_data
               order_delivery_address · order_status_history · complaints
auth.ts        sessions · email_verification_tokens · password_reset_tokens
               login_attempts
content.ts     tos_versions · tos_acceptances · privacy_policy
               settings · redirects
ops.ts         catalog_backups · admin_audit_log · cookie_consents
```

### Cross-cutting conventions

- **IDs**: `uuid` with `gen_random_uuid()` default, except where a stable
  business key already exists (`settings.key`, `tos_versions.version_number`).
  Switching to UUIDv7 later is a default-change, not a type change.
- **Money**: integer cents in `numeric(10,2)` or `numeric(12,2)`. Never floats.
  The API converts cents ↔ EUR at the boundary.
- **Timestamps**: `timestamp with time zone` (timestamptz), default `now()`,
  application-managed `updated_at` via Drizzle's `$onUpdate`.
- **Soft delete**: nullable `deleted_at`. Queries must `WHERE deleted_at IS NULL`.
- **Optimistic locking**: `version` column on `orders` (extend to other rows
  if and when concurrent admin editing is observed in practice).
- **Idempotency**: `idempotency_key` unique on `orders`; keys are
  application-generated UUIDs accompanying every checkout request.
- **Snapshots**: `order_items` carries product code/name/price; the original
  `products` row may later be edited or deleted without touching history.

## Testing the schema

Add `vitest` + a fixture-based test layer in a follow-up slice. The current
package validates via:

- `npm run typecheck` — TypeScript compiles every schema file
- `npm run db:generate` — drizzle-kit can serialise the schema to SQL without
  errors (catches conflicts like duplicate index names)
- `npm run db:migrate && npm run db:seed` — round-trip succeeds against a real
  Postgres in Docker

A failure of any of those three on a PR means do not merge.
