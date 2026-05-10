# Best-Online-Shop

[![CI](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml)

Online shop project — Bulgarian-language e-commerce platform on AWS.

## Repository layout

```
.
├── package.json      npm workspaces root
├── frontend/         Next.js 16 + React 19 app (Amplify Hosting)
├── backend/
│   ├── db/           Drizzle schema + migrations + seed (@shop/db)
│   ├── auth/         Pure auth crypto primitives (@shop/auth)
│   ├── email/        Transactional email — SES + console + stub (@shop/email)
│   └── shop-api/     Hono API: catalog read + auth slice (@shop/api)
├── infra/            Terraform IaC (planned)
├── .github/
│   └── workflows/    CI: typecheck, lint, auth tests, API tests w/ Postgres
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
npm --workspace @shop/auth  run test   # pure crypto unit tests
npm --workspace @shop/email run test   # template + transport unit tests
npm --workspace @shop/api   run test   # integration tests against shop_test DB

# Everything CI runs (typecheck + lint + tests). Approximates a green PR:
npm run typecheck --workspaces --if-present   # 4 backend workspaces
npm --workspace shop run lint
npm --workspace @shop/auth  run test
npm --workspace @shop/email run test
npm --workspace @shop/api   run test
```

## Continuous integration

Every pull request and every push to `main` runs
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). Four jobs run in
parallel and each is independently failable so PR status checks pinpoint the
exact regression:

| Job              | What it runs                                                          | Service |
| ---------------- | --------------------------------------------------------------------- | ------- |
| `typecheck`      | `tsc --noEmit` across `@shop/db`, `@shop/auth`, `@shop/email`, `@shop/api` | —  |
| `lint`           | `next lint` on the frontend                                           | —       |
| `auth-tests`     | Unit tests in `@shop/auth` (Argon2 + session tokens) and `@shop/email` (templates + transports) | —       |
| `api-tests`      | Integration tests in `@shop/api`                                      | Postgres 17 |

Hardening:

- All third-party actions pinned to **commit SHAs**, not tags — immutable
  against repo-jacking (after the tj-actions/changed-files attack of March
  2025 and the trivy-action attack of March 2026).
- Top-level `permissions: contents: read` (least privilege; the GitHub default
  would be write).
- `persist-credentials: false` on every `actions/checkout` so a later
  malicious step can't exfiltrate the workflow token from `.git/config`.
- `concurrency.cancel-in-progress: true` cancels superseded runs when a
  developer pushes fixup commits to the same branch — saves several
  runner-minutes per noisy PR.

Two checks are deliberately deferred:

- **`next build`** — the home page uses Next.js ISR
  (`next: { revalidate: 300 }` in `fetchProducts` / `fetchCategoryTree`),
  which performs static generation against a live API at build time.
  Spinning up the API + a seeded Postgres alongside the build is doable
  but slow and fragile; `typecheck` + `lint` cover the bulk of the
  build-time signal in the meantime. Add it once we either move the home
  page to dynamic rendering or have a build-time API stub.

- **Frontend `tsc --noEmit`** — running tsc cross-workspace, the frontend's
  `hc<AppType>(...)` from `@shop/api` infers `unknown`. The Hono RPC
  AppType resolution doesn't propagate through the npm workspace symlink
  the same way Next.js's official TS plugin (which the dev server and
  `next build` use) does. Until that's untangled, `next build` is the
  frontend's type gate — run it locally before pushing.

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
(no second order, cart left untouched).

## Email verification

Registration issues a 32-byte CSPRNG token (SHA-256 at rest, 24h validity)
and sends a Bulgarian verification email. Until the email is confirmed,
order placement returns
`403 /problems/email-not-verified`; the rest of the catalog and cart
remain reachable. The shop layout shows a sticky amber banner to logged-in
users with `email_verified_at = NULL` carrying an "Изпрати отново" button,
which calls `POST /auth/resend-verification` (rate-limited to 3/hour and
5/day per user, returning `429 /problems/resend-rate-limited`).

In **local dev** the `console` transport prints the verification email to
`api:dev`'s stdout with a `VERIFY URL ⇒ …` line you can copy-paste into
a browser tab. No SMTP server, no AWS account, no DKIM dance — just
register → look at the API terminal → open the URL → done.

In **production** flip `EMAIL_TRANSPORT=ses` and complete the SES DNS
prerequisites BEFORE going live (Google/Yahoo/Microsoft 2026 bulk-sender
rules require all three to be aligned):

- DKIM verified (3 CNAMEs in the SES console).
- Custom MAIL FROM subdomain (e.g. `mail.shop.example.com`) so the SPF
  record aligns with the visible `From:` domain.
- DMARC record at `_dmarc.shop.example.com` — start with `p=none` to
  collect aggregate reports, tighten to `p=quarantine` once clean.
- Move the SES account out of sandbox via Service Quotas → SES.

Token cryptography mirrors the session-token design in `@shop/auth`:
32-byte CSPRNG → base64url, SHA-256 hashed in the DB, single-use
(`consumed_at` set on first use, subsequent uses rejected with the same
generic 400 — no enumeration of token state). 24-hour expiry; the
schema's `email_verification_tokens.kind` enum already supports the
future `email_change` flow without a migration.

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
- **Email transports** (`@shop/email`): a small interface (`send(email)`)
  with three implementations — `ses` (production, `@aws-sdk/client-sesv2`
  SESv2 `SendEmailCommand`, region-pinned to `eu-central-1` for GDPR
  data residency), `console` (dev — logs the payload + a `VERIFY URL ⇒`
  line so a developer can click straight from the API terminal), and
  `stub` (in-memory recorder for tests). Selected by
  `EMAIL_TRANSPORT={ses,console,stub}` env. The transport is constructed
  lazily on first send, then memoised — keeps the Lambda cold-start
  budget tight.
- **Verification token cryptography** mirrors session tokens: 32-byte
  CSPRNG → base64url, SHA-256 hashed in `email_verification_tokens.token_hash`,
  single-use, 24-hour validity. Bad / expired / already-consumed tokens
  return the SAME generic 400, no enumeration of token state.
- **Best-effort verification email send**: registration NEVER rolls back
  on email failure (an SES outage would otherwise block all signups).
  Logs the error and continues; the user can recover via
  `/auth/resend-verification` (rate-limited 3/hour, 5/day).

## Status

### Backend

- **`@shop/db`** — schema feature-complete for catalog, auth, cart, and orders.
  30 tables, 32 FKs, 43 indexes, 10 enums. Idempotent seed.
  `email_verification_tokens` and `password_reset_tokens` were already in
  the schema with `kind` (`signup` / `email_change`), `consumed_at`,
  `expires_at` — the verification slice consumed them without a migration.
- **`@shop/auth`** — Argon2id helpers, session token generation/hashing,
  `DUMMY_PASSWORD_HASH`. 16 unit tests.
- **`@shop/email`** — transactional email. Three transports
  (`createSesTransport`, `createConsoleTransport`, `createStubTransport`)
  behind a common `EmailTransport` interface, plus the
  `renderVerificationEmail` template (Bulgarian copy, inline-styled HTML
  + plain-text fallback). `@aws-sdk/client-sesv2` is the only runtime
  dep — no Nodemailer, no full SDK. Unit tests cover template rendering,
  the SES `SendEmailCommand` shape (with a mocked client — never hits
  AWS), and the stub transport's recorder API.
- **`@shop/api`** — exposes:
  - `/products`, `/categories` (read API, ETag, cursor pagination)
  - `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`
  - `/auth/verify-email`, `/auth/resend-verification` — signup-token
    flow. 32-byte CSPRNG → base64url, SHA-256 at rest, 24h validity,
    single-use (`consumed_at`). `verify-email` is unauthenticated (the
    link IS the proof of ownership); `resend-verification` requires a
    session, is rate-limited at 3/hour and 5/day per user (returning
    `429 /problems/resend-rate-limited`), and silently no-ops for an
    already-verified user (no enumeration of verification state). Bad,
    expired, or already-consumed tokens return the SAME generic
    `400 /problems/invalid-verification-token`.
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
  - 100+ integration tests (catalog, categories, auth, cart, orders, and
    the verification slice — register-sends-mail, verify happy/unknown/
    expired/reused, resend auth-required/already-verified/rate-limit)
    against `shop_test` DB. The vitest config forces
    `EMAIL_TRANSPORT=stub` so tests can assert on what was "sent" without
    hitting AWS; `per-test.ts` resets the recorder before every test.
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
- **Email verification UI** wired end-to-end:
  - `lib/auth/client.ts` — added `verifyEmail(token)` and
    `resendVerification()`. New `resend_rate_limited` variant on the
    `AuthError` discriminated union.
  - `app/(shop)/account/verify-email/page.tsx` — handles the
    `?token=…` link click. Posts once on mount (a `useRef` guards the
    React 19 strict-mode double-invoke that would otherwise burn the
    token). Three terminal states: pending → success / failure with
    Bulgarian copy. On success, `AuthContext.refresh()` re-reads
    `/auth/me` so the unverified-banner disappears immediately.
  - `components/layout/EmailVerificationBanner.tsx` — sticky amber banner
    in `(shop)/layout.tsx` shown to logged-in users with
    `emailVerifiedAt = null`. Carries an "Изпрати отново" button that
    calls `/auth/resend-verification` and surfaces the 429 message
    inline. Hidden for the admin surface.
- **Still on mock data**: product detail pages, search, admin
  product/category/order/customer screens. These are next slices.

### Deferred (auth-adjacent, not in this slice)

- Password reset (token table is in place; UI + endpoints are the next
  slice that pairs with email verification).
- MFA for admin (admin-api is its own slice).
- Corporate registration UI + backend endpoint.
- Account deletion / GDPR anonymization.
- Profile edit (`PATCH /auth/me`, password change endpoint).
- Login attempts retention sweep (180-day window — needs scheduler slice).

### Infrastructure / CI

- Infrastructure (Terraform): not started.
- **GitHub Actions CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
  — five parallel jobs running on every `pull_request` against `main`
  and every `push` to `main`: `typecheck` (4 backend workspaces),
  `lint` (frontend), `auth-tests`, `email-tests` (templates +
  transports, SES mocked), and `api-tests` (against a Postgres 17
  service container). All third-party actions pinned to commit SHAs;
  least-privilege `permissions: contents: read`;
  `concurrency.cancel-in-progress: true`. See the
  [Continuous integration](#continuous-integration) section above for
  the full design notes and what's deliberately deferred.
- **Branch protection**: not configured yet. Once the workflow has run
  green at least once, add a branch protection rule on `main` requiring
  all five checks to pass before merging — this is what converts CI from
  "informational" to "actually protective".

### Recommended next slices

- **Password reset** — pairs naturally with the verification slice.
  Schema's `password_reset_tokens` table is already in place. Endpoints
  needed: `POST /auth/forgot-password` (issues a token + sends mail,
  returns generic ok), `POST /auth/reset-password` (consumes token,
  rotates `password_hash`, drops all sessions for the user via the
  existing `deleteAllSessionsForUser`). 1h token lifetime per OWASP.
- **SES production DNS** — before flipping `EMAIL_TRANSPORT=ses` in
  production, complete DKIM verification (3 CNAMEs), Custom MAIL FROM
  subdomain (so SPF aligns with the visible `From:`), DMARC TXT record,
  and move the SES account out of sandbox via Service Quotas. Required
  by Google/Yahoo/Microsoft/La Poste 2026 bulk-sender rules — without
  it, every verification email lands in spam.
- **Real product detail / search pages** — replaces the remaining mock
  catalog data on the storefront. Account orders pages are already real.
- **Production driver swap for orders** — `db.transaction()` on Drizzle's
  `neon-http` simulates batching rather than holding a connection, so
  `SELECT FOR UPDATE` locks won't survive between sub-statements in
  production. Either swap the orders Lambda to `neon-serverless`
  (WebSocket) or rely on an additional optimistic check.
- **Frontend `tsc --noEmit` in CI** — the cross-workspace `hc<AppType>(...)`
  inference issue (see CI section above) needs to be untangled before the
  frontend can join the typecheck job. Workaround today: `next build`
  locally before pushing.
- **`react-hooks/set-state-in-effect` two architectural cases** — the
  in-effect refresh in `AuthContext` (initial `/auth/me` bootstrap) and
  the auth-flip mode switch in `CartContext` are currently suppressed
  with rationale comments. The proper fix is a data-fetching layer
  (TanStack Query / SWR / Suspense + `use()`) — separate slice.
- **14-day right-of-withdrawal button** — required by EU Directive
  2023/2673 from June 19 2026. The `complaints` table already carries
  a `withdrawal` enum value; only the customer-facing button + admin
  workflow are missing.
