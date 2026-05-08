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
npm --workspace @shop/api  run test    # 93 integration tests against shop_test DB
```

Visit http://localhost:3000 — register a personal account, log in, click
through to `/account/profile`. The session cookie is set by the API and the
header re-renders with your name once `/auth/me` resolves.

To smoke-test the cart-on-login merge: open an incognito window, add a couple
of products to the cart while anonymous, then log in. The previously local
`sessionStorage` cart is silently merged into your server cart and persists
across devices.

To smoke-test order placement, you can now drive the whole thing through the
UI: register and log in, add a couple of products to the cart, walk through
`/checkout` → `/checkout/review`, click **Потвърди поръчката**, land on
`/account/orders/{orderNumber}?confirm=1` with a green confirmation banner,
and see your order appear at `/account/orders`. The browser issues an
`OPTIONS` preflight for `Idempotency-Key` (a non-simple header) before the
`POST` — the API's CORS allowlist explicitly includes it.

If you'd rather drive the API directly, the call shape is:

```http
POST /orders
Cookie: shop_session=…
Idempotency-Key: <client-generated v4 UUID>

{ "paymentMethod": "pay_at_store" }
```

or with delivery:

```http
POST /orders
Cookie: shop_session=…
Idempotency-Key: <client-generated v4 UUID>

{
  "paymentMethod": "cash_on_delivery",
  "deliveryAddress": { "city": "София", "postalCode": "1000",
                       "street": "бул. Витоша 25",
                       "apartmentOrOffice": "ап. 4" },
  "notes": "Позвънете преди доставка"
}
```

Replaying the same `Idempotency-Key` returns the original order verbatim
(no second order, cart left untouched). Until the email-verification slice
lands, customers registered via the live API have a NULL `email_verified_at`
and the order endpoint returns 403 — bump it manually with
`UPDATE users SET email_verified_at = now() WHERE email = '…';` to test.

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
  `credentials: "include"` on every `/auth/*`, `/cart/*`, `/orders/*` fetch;
  API echoes the origin from an allowlist (no wildcard, which is incompatible
  with credentials). `allowHeaders` includes `Idempotency-Key` — a non-simple
  request header forces an `OPTIONS` preflight, and the server has to
  advertise the header explicitly or the browser blocks the actual `POST`.
- **Next.js 16 thin proxy** (`frontend/src/proxy.ts`, formerly `middleware.ts`):
  cookie-presence check only, never validates the token. Real auth happens
  in pages and Server Components.
- **SSR identity bootstrap**: root layout calls `getServerUser()` which
  forwards the session cookie via `next/headers` to `GET /auth/me`. Initial
  user is passed into the client `AuthProvider` so first paint already shows
  the logged-in header — no auth flicker.
- **Two-mode cart**: `sessionStorage` for guests (per-tab, dies with the
  tab — matches the spec), server-persisted for authenticated users. On
  login, `POST /cart/merge` silently sums the guest cart into the server
  cart (matching the Amazon/Target/Etsy/Walmart pattern). Cart reads always
  hydrate from the live `products` table — price and stock are never
  snapshotted on the cart row, so the cart always reflects today's catalog.
  Item-level upserts use raw SQL (`INSERT … ON CONFLICT DO UPDATE`) with
  `LEAST(…, 99)` for the per-line cap; bulk lookups use Drizzle's `inArray`
  rather than `ANY($1::uuid[])` because the latter can't bind a JS array
  portably across `node-pg` / `neon-http`.
- **Transactional checkout** (`POST /orders`): one `db.transaction(async tx
  => …)` wraps cart-read with `SELECT … FOR UPDATE OF products`, stock +
  cart-empty validation, account-discount lookup, order header insert, line-
  item snapshots (productCode / productName / productImageS3Key /
  unitPriceCents — historical orders survive any later catalog edit),
  status-history seed entry, optional `order_delivery_address` and
  `order_corporate_data` snapshots, and cart clearing — all atomic.
- **Idempotency-Key header** on `POST /orders` (Stripe / MDN pattern). The
  client generates a UUID, sends it via the HTTP header; the server stores
  it on the order row (UNIQUE) and on retry returns the original order
  verbatim. Cross-customer collisions on the global UNIQUE map to a 409.
  z.object schema key MUST be lowercase to match Hono's normalised header
  payload, and `param.name` is NOT overridden in `.openapi()` — overriding
  with a different case throws `ConflictError("Conflicting names for
  parameter")` inside the OpenAPI generator.
- **Public order numbers** are formatted as `YYYY-MM-NNNNN` from a single
  Postgres sequence (`orders_order_number_seq`) plus `to_char(now() AT TIME
  ZONE 'Europe/Sofia', 'YYYY-MM')` so the prefix matches the customer's
  local calendar month. Sequence is monotonically increasing for life;
  `lpad(_, 5, '0')` widens past 99,999 lifetime orders without code change.
- **Email-verified gate on order placement**: customers with a NULL
  `email_verified_at` get a 403 `/problems/email-not-verified`. Browsing
  and cart building stay unrestricted.

## Status

### Backend

- **`@shop/db`** — schema feature-complete for catalog, auth, cart, and orders.
  30 tables, 32 FKs, 43 indexes, 10 enums. Idempotent seed.
- **`@shop/auth`** — Argon2id helpers, session token generation/hashing,
  `DUMMY_PASSWORD_HASH`. 16 unit tests.
- **`@shop/api`** — exposes:
  - `/products`, `/categories` (read API, ETag, cursor pagination)
  - `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`
  - `/cart`, `/cart/items`, `/cart/items/:productId`, `/cart/merge`
    (gated by `requireAuth`; live-price hydration; silent-sum merge on
    duplicate; per-line cap of 99; out-of-stock add → 409; soft-deleted
    products excluded from reads)
  - `/orders`, `/orders/:orderNumber` (gated by `requireAuth`; place-order
    flow with `Idempotency-Key` header; transactional consume-cart-into-
    order with `SELECT … FOR UPDATE OF products`; price + image snapshots
    on `order_items`; per-customer scoping on list/detail returns generic
    404 for someone else's order — no enumeration; `cash_on_delivery`
    requires `deliveryAddress`, `pay_at_store` does not; corporate accounts
    snapshot `order_corporate_data`; email-verified gate)
  - `/health`, `/openapi.json`
  - 93 integration tests (15 catalog + 7 categories + 16 auth + 30 cart +
    25 orders) against `shop_test` DB.
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
- **Real cart wired end-to-end** to `@shop/api`:
  - `lib/cart/client.ts` — typed REST client mirroring the auth-client
    pattern; maps RFC 9457 problems into a `CartError` discriminated union
    (`unauthenticated`, `not_found`, `out_of_stock`, `validation`, `network`,
    `unknown`).
  - `contexts/CartContext.tsx` — two-mode provider: anonymous renders from
    `sessionStorage` snapshots, authenticated round-trips every mutation
    against the server. Auth-status transitions trigger merge-on-login and
    drop-on-logout. Optimistic UI for set-quantity / remove with rollback.
  - `CartDrawer`, `ProductCard`, `ProductDetailView`, `/checkout`,
    `/checkout/review` migrated from the old decimal-`price` shape to the
    server's `priceCents` shape. New `formatCents` helper in `lib/utils.ts`.
- **Real order placement wired end-to-end** to `@shop/api`:
  - `lib/orders/types.ts` — wire DTOs (`OrderDTO`, `OrderItem`,
    `OrderDeliveryAddress`, `OrderCorporateData`) and an `OrderError`
    discriminated union with one variant per RFC 9457 `type` the backend
    can return (`validation`, `unauthenticated`, `email_not_verified`,
    `out_of_stock`, `idempotency_conflict`, `cart_empty`, `profile_required`,
    `not_found`, `network`, `unknown`). The submit handler exhaustively
    branches and TS flags any new variant.
  - `lib/orders/client.ts` — typed REST client (`placeOrder`, `fetchOrders`,
    `fetchOrder`) sending `credentials: "include"` and the
    `Idempotency-Key` header on placement.
  - `app/(shop)/checkout/review/page.tsx` — submit handler generates one
    `crypto.randomUUID()` Idempotency-Key per page mount, kept in a
    `useRef` so retries reuse it. Regenerates only on the rare
    `/problems/idempotency-conflict` 409. Translates every error into
    Bulgarian copy. Calls `clearCart()` after success so the cart drawer
    doesn't show stale lines until the next reload. Routes to
    `/account/orders/{orderNumber}?confirm=1` on 201.
  - `app/(shop)/account/orders/page.tsx` — real `GET /orders`, skeleton
    loading, login bounce.
  - `app/(shop)/account/orders/[id]/page.tsx` — real `GET /orders/:n`,
    doubles as the post-checkout confirmation page (driven by
    `?confirm=1`). Renders delivery address, corporate snapshot for B2B,
    notes. Cross-user 404s render the same not-found copy as a missing
    order — preserves the backend's enumeration-resistant contract.
- **Still on mock data**: product detail pages, search, admin
  product/category/order/customer screens. These are next slices.

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

### Recommended next slices

- **CI on GitHub Actions** — `pull_request` + `push to main` running
  `typecheck` + `auth:test` + `api:test` against a service-container
  Postgres. Protects the 93 backend tests as the surface keeps growing.
  Highest-leverage foundational slice now that the user-facing flow is
  real and regressions can affect actual checkout.
- **Email + verification** (SES wiring + 24h tokens + rate-limited resend).
  Closes the registration enumeration loop and unblocks password reset.
  Also lifts the manual `UPDATE users SET email_verified_at = now()`
  workaround currently required to test order placement.
- **Real product detail / search pages** — replaces the remaining mock
  catalog data on the storefront. Account orders pages are already real.
- **Production driver swap for orders** — `db.transaction()` on Drizzle's
  `neon-http` simulates batching rather than holding a connection, so
  `SELECT FOR UPDATE` locks won't survive between sub-statements in
  production. Either swap the orders Lambda to `neon-serverless`
  (WebSocket) or rely on an additional optimistic check.
- **14-day right-of-withdrawal button** — required by EU Directive
  2023/2673 from June 19 2026. The `complaints` table already carries
  a `withdrawal` enum value; only the customer-facing button + admin
  workflow are missing.
