# Best-Online-Shop

Online shop project — Bulgarian-language e-commerce platform on AWS.

## Repository layout

```
.
├── package.json      npm workspaces root
├── frontend/         Next.js 16 + React 19 app (Amplify Hosting)
├── backend/
│   ├── db/           Drizzle schema + migrations + seed (@shop/db)
│   ├── auth/         Pure auth crypto primitives (@shop/auth)
│   └── shop-api/     Hono API: catalog read + auth slice (@shop/api)
├── infra/            Terraform IaC (planned)
├── .github/
│   └── workflows/    CI/CD pipelines (planned)
└── docs/
    ├── README.md                     Functional / product specification
    ├── TECHSPEC.md                   AWS infrastructure architecture
    └── AWS_PRICING_RESEARCH_2026.md  Verified rate sheet for cost calculations
```

This is an **npm workspaces** monorepo. One `npm install` at the root
provisions every workspace; cross-package imports (`@shop/db`, `@shop/auth`,
`@shop/api`) are linked automatically.

## Bring it up locally

```powershell
# From the repo root, one time:
npm install
copy backend\shop-api\.env.example backend\shop-api\.env
copy frontend\.env.local.example frontend\.env.local

# Database (Docker Postgres 17):
npm run db:up
npm run db:reset            # migrate + seed in one shot

# API (Hono on Node, http://localhost:3001):
npm run api:dev

# Frontend (Next.js, http://localhost:3000):
npm run frontend:dev

# Tests:
npm --workspace @shop/auth run test    # 16 unit tests   (pure crypto)
npm --workspace @shop/api  run test    # 38 integration tests against shop_test DB
```

Visit http://localhost:3000 — register a personal account, log in, click
through to `/account/profile`. The session cookie is set by the API and the
header re-renders with your name once `/auth/me` resolves.

## Documentation

Read the docs in this order:

1. `docs/README.md` — what the shop does (product spec, in Bulgarian)
2. `docs/TECHSPEC.md` — how it's hosted on AWS (English, with Bulgarian sections)
3. `docs/AWS_PRICING_RESEARCH_2026.md` — verified AWS rates underpinning the cost tables

## Architecture decisions in force

A handful of decisions cut across every slice — listed here so they don't
have to be re-derived when extending the codebase.

- **Drizzle**, not Prisma. Money in integer cents, `numeric(10,0)`. Timestamps
  `timestamptz`. UUIDs via `gen_random_uuid`. Soft delete via `deleted_at`.
  Optimistic locking via `version` on orders. `idempotency_key` unique.
  Order line items are snapshotted into `order_items`.
- **Neon Scale only** in production (Free/Launch are SPOFs). `createDb()`
  picks Neon HTTP driver in prod vs node-pg in dev.
- **Hono on Lambda**. Same handler runs on Node locally via `@hono/node-server`.
  Hono RPC gives the frontend end-to-end types from a single `AppType` import.
- **Zod 4 + `@hono/zod-openapi`** auto-generates OpenAPI 3.1 from the typed
  routes. `defaultHook` is extracted to `lib/validation-hook.ts` because it
  does NOT propagate from a parent `OpenAPIHono` to sub-routers.
- **RFC 9457 Problem Details** for every error response.
- **Cursor (keyset) pagination**, opaque base64url, id tiebreaker.
- **`Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=60`**
  + ETag middleware on cacheable routes.
- **Pino + JSON logs**, PII redaction, per-request child logger keyed on
  `X-Request-Id`.
- **Argon2id** for passwords (`m=19456, t=2, p=1`, OWASP low-mem). 32-byte
  CSPRNG session token, SHA-256-hashed at rest in `sessions.id_hash`.
  `__Host-shop_session` cookie in prod, `shop_session` in dev. SameSite=Lax,
  HttpOnly, Secure (prod). Max-Age set only when `rememberMe=true`.
- **Constant-time login**: unknown email runs `argon2.verify` against
  `DUMMY_PASSWORD_HASH`. Identical 401 body for unknown-email and wrong-password.
  Generic `{ ok: true }` for both new and duplicate registration to prevent
  enumeration.
- **Brute-force defence**: per-email, 5 fails in trailing 15-min window →
  15-min lockout. 6th attempt returns 429 with
  `type=/problems/account-locked`. IP-volume defence belongs at WAF.
- **Two-tier auth middleware**: `currentUser` (best-effort, never 401s) plus
  `requireAuth` (gate). `currentUser` runs on `/products/*`, `/categories/*`,
  `/auth/*`. `/health` is intentionally excluded.
- **CORS with credentials** explicitly enabled. Frontend uses
  `credentials: "include"` on every `/auth/*` fetch; API echoes the origin
  from an allowlist (no wildcard, which is incompatible with credentials).
- **Next.js 16 thin proxy** (`frontend/src/proxy.ts`, formerly `middleware.ts`):
  cookie-presence check only, never validates the token. Real auth happens
  in pages and Server Components.
- **SSR identity bootstrap**: root layout calls `getServerUser()` which
  forwards the session cookie via `next/headers` to `GET /auth/me`. Initial
  user is passed into the client `AuthProvider` so first paint already shows
  the logged-in header — no auth flicker.

## Status

### Backend

- **`@shop/db`** — schema feature-complete for catalog, auth, cart, and orders.
  30 tables, 32 FKs, 43 indexes, 10 enums. Idempotent seed.
- **`@shop/auth`** — Argon2id helpers, session token generation/hashing,
  `DUMMY_PASSWORD_HASH`. 16 unit tests.
- **`@shop/api`** — exposes:
  - `/products`, `/categories` (read API, ETag, cursor pagination)
  - `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`
  - `/health`, `/openapi.json`
  - 38 integration tests (22 catalog + 16 auth) against `shop_test` DB.
  - `PublicUser` response includes `fullName` resolved from
    `customer_profiles` / `corporate_profiles` (null for admins).

### Frontend

- **Real auth wired end-to-end** to `@shop/api`:
  - `lib/auth/client.ts` — browser helpers (`login`, `register`, `logout`,
    `fetchMe`) with `credentials: "include"` and RFC 9457 error mapping
    into a typed `AuthResult<T>` discriminated union.
  - `lib/auth/server.ts` — `getServerUser()` for SSR identity bootstrap.
  - `contexts/AuthContext.tsx` — hydrates from SSR or client `/auth/me`,
    exposes `login`/`register`/`logout`/`refresh`.
  - Real login + register pages with Bulgarian error copy, "Запомни ме",
    `?next=` honour with open-redirect protection.
  - `app/admin/layout.tsx` — server component enforcing `role === "admin"`.
  - `proxy.ts` — Next.js 16 thin-proxy gating `/account/*` and `/admin/*`.
- **Still on mock data**: product detail pages, search, account orders,
  admin product/category/order/customer screens. These are next slices.
- **Still localStorage-only**: cart. Cart-on-server slice is the planned
  follow-up — schema is ready (`cart_items` keyed by anonymous session token,
  merge on login).

### Deferred (auth-adjacent, not in this slice)

- Email verification + password reset (need SES wiring).
- MFA for admin (admin-api is its own slice).
- Corporate registration UI + backend endpoint.
- Account deletion / GDPR anonymization.
- Profile edit (`PATCH /auth/me`, password change endpoint).
- Login attempts retention sweep (180-day window — needs scheduler slice).

### Infrastructure / CI

- Infrastructure (Terraform): not started.
- GitHub Actions workflows: not started. CI on `pull_request` + `push to main`
  running `typecheck` + `auth:test` + `api:test` against a service-container
  Postgres is the recommended next foundational slice.
