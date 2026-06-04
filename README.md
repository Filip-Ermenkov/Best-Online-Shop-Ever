# Best-Online-Shop-Ever

[![CI](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml)

Bulgarian-language B2C and B2B e-commerce platform. Cash on delivery
or pay-at-store only — no card data. Single-tenant, single-admin.
Target deployment is AWS Frankfurt (`eu-central-1`) for GDPR data
residency, but **as of 2026-05-26 the codebase is not yet deployed to
AWS** — see the [Deployment status](#deployment-status) section below
for an honest read on what is shipped, what is wired but not
deployed, and what is still a roadmap item.

## Documentation map

Four docs, four roles. Read them in this order if you're new:

| Doc | What's in it | When to read |
|---|---|---|
| [`README.md`](./README.md) (this file) | Onboarding, local dev, current status, decisions in force | First |
| [`docs/README.md`](./docs/README.md) | Functional / product spec, **in Bulgarian** — what the shop does | To understand the product |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Single technical reference: layers, request lifecycle, security, reliability, observability, supply chain, cost, operations, roadmap, forward-looking design considerations | To understand how it's built |
| [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) | Standards-by-standards matrix (NIST CSF 2.0, OWASP Top 10 2025, OWASP ASVS 6.0, NIST SP 800-63B-4, SLSA, CIS Controls v8.1, GDPR, EU Directive 2023/2673, WCAG 2.2). Auditor-facing | To answer "are we compliant with X?" |

If you only have time for one doc, read this one — it links to the
others where appropriate.

## Repository layout

```
.
├── package.json          npm workspaces root (1 frontend + 4 backend workspaces)
├── frontend/             Next.js 16 + React 19 app (planned for Amplify Hosting)
├── backend/
│   ├── db/               Drizzle schema + migrations + seed (@shop/db)
│   ├── auth/             Pure auth crypto primitives (@shop/auth)
│   ├── email/            Transactional email — SES + console + stub (@shop/email)
│   └── shop-api/         Hono API: catalog read + auth + cart + orders + CSP reporting (@shop/api)
├── .github/workflows/    CI: typecheck, lint, tests (5 jobs in ci.yml) + CodeQL SAST + SBOM/Sigstore
└── docs/
    ├── README.md         Functional spec (Bulgarian)
    ├── ARCHITECTURE.md   Technical reference + roadmap + forward-looking design
    ├── COMPLIANCE.md     Standards matrix
    └── ACCESSIBILITY.md  WCAG 2.2 AA / EAA conformance + audit + manual checklist
```

Not yet present in the repo (mentioned in `docs/ARCHITECTURE.md` as
future work):

- `infra/` — Terraform IaC. The runbook for "what AWS resources back
  this codebase" lives in the architecture doc as prose; there is no
  IaC yet.
- `backend/admin-api/` — admin Lambda. Admin flows are currently
  stubbed on the frontend with mock data; there is no admin API.
- `backend/scheduler-fn/` — scheduled-Lambda for the three cron rules
  (daily catalog backup, hourly pickup expiry, daily unverified-account
  cleanup). Not built.

This is an **npm workspaces** monorepo. One `npm install` at the
root provisions every workspace; cross-package imports
(`@shop/db`, `@shop/auth`, `@shop/email`, `@shop/api`) are linked
automatically.

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

# Frontend (Next.js 16, http://localhost:3000):
npm run frontend:dev
```

Visit http://localhost:3000. Register a personal account, log in,
click through to `/account/profile`. The session cookie is set by the
API and the header re-renders with your name once `/auth/me`
resolves.

When you verify your email and place an order, the API also sends an
order-confirmation email — see [Order placement](#order-placement)
below. In local dev the `console` transport prints the rendered
subject + body to the `api:dev` log.

To smoke-test the cart-on-login merge: open an incognito window, add a
couple of products to the cart while anonymous, then log in. The
previously local `sessionStorage` cart is silently merged into your
server cart and persists across devices.

To smoke-test order placement: register, log in, add products, walk
through `/checkout` → `/checkout/review`, click **Потвърди
поръчката**, land on
`/account/orders/{orderNumber}?confirm=1` with a green confirmation
banner. The API also queues a Bulgarian-language order-confirmation
email (best-effort — a transport failure does not fail the order; the
order is durable in the DB regardless). Watch `api:dev`'s stdout for
the rendered payload under the `console` transport. The order is also
visible at `/account/orders`.

### Tests

```powershell
npm --workspace @shop/auth  run test   # 31 unit tests (Argon2, sessions, HIBP)
npm --workspace @shop/email run test   # 51 unit tests (12 templates + 3 transports)
npm --workspace @shop/api   run test   # full integration suite (304 cases) vs shop_test DB
```

Accessibility (WCAG 2.2 AA / EAA) has its own layered audit — see
[Accessibility](#accessibility-wcag-22-aa--eaa) below and
`docs/ACCESSIBILITY.md`:

```powershell
npm --workspace shop run lint          # static jsx-a11y rules (also in CI)
cd frontend
npm run test:a11y:install              # one-time: fetch Chromium
npm run test:a11y                      # runtime axe-core scan (boots next dev)
```

Everything CI runs (typecheck + lint + tests). Approximates a green PR:

```powershell
npm run typecheck --workspaces --if-present   # 4 backend workspaces
npm --workspace shop run lint                 # frontend (next lint)
npm --workspace @shop/auth  run test
npm --workspace @shop/email run test
npm --workspace @shop/api   run test
```

The frontend's `next build` and `tsc --noEmit` are deliberately *not*
in CI today; see [Continuous integration](#continuous-integration)
below for why.

## Deployment status

**The codebase has not yet been deployed to production AWS.** Several
sections of the older documentation read as if a deployment is live;
they aren't. The honest state:

| Component | Status |
|---|---|
| Frontend (Next.js 16) | Builds locally; not deployed to Amplify |
| `shop-api` Lambda (Hono) | Runs locally via `@hono/node-server`; not deployed to Lambda |
| Database | Local Docker Postgres 17 works; Neon production instance not provisioned |
| Email | `console` transport works locally; `ses` transport code exists but SES production DNS not configured |
| WAF / CloudFront / Route 53 | Not provisioned |
| `admin-api` Lambda | Not built |
| `scheduler-fn` Lambda | Not built |
| Terraform / IaC | Not started |

The architecture documentation (`docs/ARCHITECTURE.md`) describes the
intended production posture. The roadmap (§15 of that file) tracks
what needs to happen to get from today's repo state to that posture.

## What's wired up

### Backend (`@shop/api` Hono routes mounted in `backend/shop-api/src/app.ts`)

- `/products`, `/categories` — read API, ETag, cursor pagination
- `/auth/*` — register, login, logout, GET+PATCH `/me`, DELETE `/me`,
  POST `/me/export` (GDPR Art. 15 + 20 personal-data export),
  verify-email, resend-verification, forgot-password,
  reset-password/check, reset-password, change-password,
  email-change/request, email-change/verify/check,
  email-change/verify
- `/cart`, `/cart/items`, `/cart/items/:productId`, `/cart/merge`
- `/orders`, `/orders/:orderNumber`,
  `/orders/:orderNumber/withdrawal`,
  `/orders/:orderNumber/withdrawal/eligibility`
- `/addresses`, `/addresses/:id` — customer address-book CRUD
  (list / create / partial-update / soft-delete). `requireAuth`-gated,
  per-user ownership-scoped, 4-digit Bulgarian postal-code validation,
  20-address cap. Activates the `addresses` table the GDPR export and
  account-deletion already reference.
- `/csp-report` — accepts both legacy `application/csp-report` and
  modern `application/reports+json`. Anonymous (intentionally outside
  the auth chain).
- `/consent` — server-side cookie-consent receipts (GDPR Art. 7(1)
  demonstrability). `POST` records an append-only receipt and mints an
  opaque, strictly-necessary `visitor_id` cookie; `GET` returns the
  visitor's current choice. Anonymous (like `/csp-report`). Activates
  the `cookie_consents` table the schema has modelled since the initial
  migration; the banner now writes here, not just to `localStorage`.
- `/health`, `/openapi.json`

Test counts as of 2026-06-04, by `it`/`test` block: addresses 28,
auth 48, cart 30, categories 7, consent 10, csp-report 25,
data-export 14, email-change 21, order-emails 5, orders 25,
password-reset 19, products 15, verification 11, withdrawal 23, plus a
phone-validation lib suite — **281 blocks**. The `csp-report` and
`phone` suites are table-driven (`it.each`), so `vitest run` expands
them and reports **315 cases total**, all against a real `shop_test`
Postgres in CI.

### Backend (`@shop/db` schema)

30 tables, 32 FKs, 44 indexes, 10 enums, 3 migrations
(`0000_initial.sql`, `0001_orders_sequence.sql`,
`0002_complaints_withdrawal.sql`). Idempotent seed in
`backend/db/scripts/seed.ts`.

### Backend (`@shop/auth`)

Argon2id helpers (`m=19456, t=2, p=1`), session token
generation/hashing, `DUMMY_PASSWORD_HASH`, and HIBP k-anonymity
breached-password screening. 31 unit tests across `breached-password`,
`password`, `session-tokens`.

### Backend (`@shop/email`)

Transactional email behind a common `EmailTransport` interface, with
three implementations (`ses`, `console`, `stub`). **Twelve** Bulgarian
templates currently exist:

1.  `verification` — signup email-verification link
2.  `password-reset` — forgot-password link
3.  `password-changed` — post-reset / post-change security notice
4.  `email-change-verify` — verify link sent to NEW address
5.  `email-change-alert` — out-of-band alert to OLD address at request time
6.  `email-changed` — post-change notice to OLD address
7.  `withdrawal-received` — 14-day withdrawal acknowledgement to customer
    (Art. 11a(2) durable medium with Sofia-timezone second-precision timestamp)
8.  `withdrawal-admin-notification` — operations notice to support inbox
9.  `account-deleted` — post-deletion notification (GDPR Art. 17 flow)
10. `order-confirmation` — durable-medium confirmation of contract
    conclusion sent the moment `POST /orders` commits. Carries the order
    snapshot, line items, money totals, delivery / pickup info, and a
    withdrawal-rights pointer per EU 2023/2673 Art. 8 + Art. 6(1)(h).
11. `order-status-update` — status-aware copy for each customer-visible
    transition (`accepted`, `ready_for_pickup`, `shipped`, `delivered`,
    `cancelled`). Template + helper land here ready for the future
    `admin-api` Lambda to wire — admin status transitions today still
    happen via direct DB updates, so the wire-up is one line away once
    that slice lands.
12. `data-exported` — out-of-band security notice sent when a customer
    runs the GDPR Art. 15/20 self-service data export (`POST
    /auth/me/export`). Carries no payload and no link (the data went
    over the authenticated channel); directs a surprised recipient to
    secure their account, mirroring the `password-changed` pattern.

### Frontend (`frontend/`)

Real auth flows wired end-to-end to `@shop/api`: register, login,
logout, `/auth/me`, profile (PATCH /auth/me with personal-vs-corporate
schema), email verification, resend-verification banner,
forgot-password, reset-password (with validate-on-mount), email change
with two-email out-of-band confirmation, authenticated password
change, account deletion (typed "ИЗТРИЙ" confirmation + current-
password re-auth).

Real cart wired end-to-end: two-mode (`sessionStorage` guests,
server-persisted users), `POST /cart/merge` on login, optimistic UI
with rollback, RFC 9457 problem-types mapped to a `CartError`
discriminated union.

Real order placement wired end-to-end: `Idempotency-Key`-headered
`POST /orders`, full `OrderError` discriminated union, listing + detail
+ withdrawal flow at `/account/orders/[orderNumber]`.

Real address book wired end-to-end at `/account/addresses` (linked from
`/account/profile`): list + add + inline-edit + two-step-confirm delete,
backed by the `/addresses` CRUD with a typed `AddressError` union in
`frontend/src/lib/addresses/`. 4-digit postal-code validation client- and
server-side. The "адресна книга" of spec §6.

Accessibility (WCAG 2.2 AA / EAA) is wired across the storefront:
contrast-fixed design tokens, a skip-to-content link, a uniform keyboard
focus indicator, `prefers-reduced-motion` handling, an ARIA combobox
search, live-region form errors, and an EAA Annex V statement at
`/accessibility`. Audited statically in CI (`eslint-plugin-jsx-a11y`) and
at runtime locally (`npm run test:a11y`, axe-core). See
`docs/ACCESSIBILITY.md`.

**Still on mock data:**

- Home page banners (`frontend/src/lib/mock-data/banners.ts`) — no
  banner-slides API endpoint yet.
- Checkout courier-office picker
  (`frontend/src/lib/mock-data/courier-offices.ts`) — Bulgarian
  Econt/Speedy office lists are real-world data not yet ingested into
  the DB.
- **Every admin page** under `/admin/*` (banners, categories,
  products, customers, orders, archive, settings) renders mock data;
  there is no admin API behind any of these screens.

Category-tree browsing (`/products/[...path]`) and search (`/search`)
moved off mock data on 2026-05-28 — see [Storefront browsing](#storefront-browsing)
below.

### Continuous integration

`.github/workflows/ci.yml` runs five parallel jobs on every pull
request and every push to `main`:

| Job | What it runs | Service |
|---|---|---|
| `typecheck` | `tsc --noEmit` across `@shop/db`, `@shop/auth`, `@shop/email`, `@shop/api` | — |
| `lint` | `next lint` on the frontend — includes the hardened `eslint-plugin-jsx-a11y` accessibility rules (the static layer of the WCAG audit) | — |
| `auth-tests` | Unit tests in `@shop/auth` | — |
| `email-tests` | Unit tests in `@shop/email` (templates + transports, SES mocked) | — |
| `api-tests` | Integration tests in `@shop/api` | Postgres 17 |

`.github/workflows/codeql.yml` runs CodeQL SAST on every PR, every
push to `main`, and a Sunday 03:00 UTC weekly cron. `security-extended`
query suite on JavaScript/TypeScript plus the `actions` query pack on
workflow YAML.

`.github/workflows/sbom.yml` generates a CycloneDX 1.6 SBOM per
workspace using `@cyclonedx/cyclonedx-npm`, signs each one via
`actions/attest-build-provenance` (GitHub OIDC → Sigstore Fulcio →
Rekor transparency log), and attaches them to releases. The verifier
recipe is in `docs/ARCHITECTURE.md` §9.5.

Hardening posture (applies to every workflow):

- All third-party actions pinned to **commit SHAs**, not tags —
  immutable against repo-jacking (post tj-actions/changed-files
  attack of March 2025 and trivy-action attack of March 2026).
- Top-level `permissions: contents: read` (least privilege).
- `persist-credentials: false` on every `actions/checkout`.
- `concurrency.cancel-in-progress: true` on every workflow.

Two checks are deliberately deferred:

- **`next build` in CI.** The home page uses Next.js ISR
  (`revalidate: 300` in `fetchProducts` / `fetchCategoryTree`),
  which performs static generation against a live API at build
  time. Spinning up the API + a seeded Postgres alongside the build
  is doable but slow and fragile; `typecheck` + `lint` cover the
  bulk of the build-time signal in the meantime. Revisit once the
  home page moves to dynamic rendering or a build-time API stub
  exists.
- **Frontend `tsc --noEmit`.** Cross-workspace, the frontend's
  `hc<AppType>(...)` from `@shop/api` infers `unknown`. The Hono
  RPC `AppType` resolution doesn't propagate through the npm
  workspace symlink the same way Next.js's official TS plugin
  (which the dev server and `next build` use) does. Until that's
  untangled, `next build` locally is the frontend's type gate —
  run it before pushing.

Branch protection on `main` is documented as a one-time GitHub UI
action in `docs/ARCHITECTURE.md` §9.4 (solo-committer + multi-
committer rule sets). It is not currently enforced.

## Smoke-test recipes

### Email verification

Registration issues a 32-byte CSPRNG token (SHA-256 at rest, 24h
validity) and sends a Bulgarian verification email. Until the email is
confirmed, order placement returns
`403 /problems/email-not-verified`; catalog and cart stay reachable.
The shop layout shows a sticky amber banner with an "Изпрати отново"
button that calls `POST /auth/resend-verification` (rate-limited 3/hour
and 5/day per user, returning `429 /problems/resend-rate-limited`).

In local dev the `console` transport prints to `api:dev`'s stdout with
a `VERIFY URL ⇒ …` line you can copy-paste into a browser tab.

### Password reset

`/account/forgot-password` → `POST /auth/forgot-password`, which
always returns the same `{ ok: true }` regardless of whether the
address is registered, internally rate-limited, or hit a send failure
(enumeration-resistant by contract). The reset email lands at
`/account/reset-password?token=…`. The page POSTs to
`/auth/reset-password/check` on mount to validate the token without
consuming it. Posting the token to `/auth/reset-password` atomically
(a) marks it consumed, (b) invalidates every other outstanding reset
token for the user, (c) rotates `password_hash`, (d) drops every
active session, (e) sends a `auth.password-changed` notification.
Token validity is 1 hour (OWASP recommendation).

### Email change

`/account/email-change` requires current-password re-auth. Issues a
token to the new address (`auth.email-change-verify`) AND sends an
alert to the old address (`auth.email-change-alert`); doing nothing
on the alert IS the revert. After click, posting the token rotates
`users.email`, sets `email_verified_at`, drops every session, and
sends `auth.email-changed` to the OLD address. Late-conflict check
guards against the destination being claimed between request and
verify. Verify is **not** auto-fired on mount (email-client scanners
would burn the token); explicit "Потвърди смяната" button.

### Authenticated password change

`/account/profile` password section → `POST /auth/change-password`
with current + new password. HIBP-screens the new password first,
rejects newPassword === currentPassword (`/problems/same-password`),
shares the per-email lockout counter with `/auth/login`, rotates the
hash on success, drops every OTHER session for the user (keeps THIS
session — the device just proved it knows the current password), and
sends `auth.password-changed`.

### Profile editing (PATCH /auth/me)

`/account/profile` → `PATCH /auth/me`. RFC 5789 partial-update
semantics, account-type-aware. Personal accounts edit `fullName` +
`phone`; corporate edit `companyName` + `vatNumber` (nullable) +
`registeredAddress` + `mol` + `contactName` + `contactPhone`. EIK /
email / password / role / accountType are deliberately read-only.
Zod `.strict()` rejects unknown keys before the handler runs (defence
in depth). Phone normalised to Bulgarian E.164 via
`backend/shop-api/src/lib/phone.ts`. No-op short-circuit if nothing
changed. Audit trail via structured Pino `profile_updated` event
(field NAMES only — values are PII).

### Account deletion (DELETE /auth/me)

`/account/delete` → `DELETE /auth/me`. Requires current-password
re-auth AND a typed confirmation phrase (`z.literal("ИЗТРИЙ")`).
Single transaction (see
`backend/shop-api/src/lib/account-deletion.ts`) balances GDPR Art.
17(1) immediate erasure with the Bulgarian Accountancy Act's 10-year
invoice retention via Art. 17(3)(b)'s legal-obligation exemption.
Hard-deleted: profiles, addresses, cart, discounts, MFA recovery
codes, sessions, tokens, login_attempts matched by original email
(Art. 5(1)(c) minimisation). Pseudonymised: `users` row stays with
`email = deleted-<uuid>@deleted.invalid` (RFC 6761), passwordHash
rewritten to a non-Argon2 sentinel. Orders kept, customer fields
blanked, financial data + line snapshots intact. Active-order check
returns `422 /problems/active-orders-block-deletion`.

### Personal-data export (GDPR Art. 15 + Art. 20)

`/account/data-export` → `POST /auth/me/export`. Requires current-
password re-auth (same posture as delete / change-password — a stolen
cookie alone must not pull a one-shot copy of everything we hold). The
builder (`backend/shop-api/src/lib/data-export.ts`) assembles a
structured, machine-readable JSON document: account, profile, address
book, cart, full order history (line items + delivery + corporate +
status history + withdrawals), per-account discount, a `securityActivity`
summary, and a `processingInformation` block (purposes, data categories,
recipient categories, retention, the catalogue of rights, supervisory
authority, automated-decision-making statement). Timestamps are ISO-8601,
money is integer cents, keys are English (portable); the transparency
strings are Bulgarian. Credentials and secrets (password/token/2FA
hashes, raw login telemetry) are excluded and the exclusion is disclosed
in `processingInformation.dataNotIncluded`. The response is served with
`Content-Disposition: attachment` + `Cache-Control: no-store`; the page
turns the blob into a browser download. A per-user frequency cap
(5/hour) returns `429 /problems/export-rate-limited`. A best-effort
`auth.data-exported` notification email fires on success.

To smoke-test: register + log in, go to `/account/profile`, click
**Изтегли данните си** (under the new "Експорт на личните Ви данни"
section), enter your password, and a `shop-data-export-YYYY-MM-DD.json`
file downloads. Watch `api:dev`'s stdout for the rendered notification
email under the `console` transport.

### Address book

`/account/addresses` (linked from `/account/profile` under "Адресна
книга") → `/addresses` CRUD. Register, log in, open the page: it starts
empty. **Добави адрес** opens the shared form — `Град`, `Пощенски код`
(exactly 4 digits — try `12` or `abcd` to see the inline rejection),
`Улица и номер`, plus optional `Етикет` and `Апартамент / офис`. Save and
the address appears in the list. **Редактирай** re-opens the same form
pre-filled (`PATCH /addresses/:id`, no-op short-circuit if nothing
changed); **Изтрий** asks "Сигурни ли сте?" inline before a soft delete
(`deleted_at` stamped, row stays in the DB for the export's transparency
view). Ownership is enforced server-side — an address id belonging to
another account returns the same `404` as a non-existent one. The book is
capped at 20 live addresses (the 21st create returns
`422 /problems/address-limit-reached`). Run a data export afterwards: the
saved addresses now appear under `addresses` in the JSON (the table was
unreachable before this slice).

### Order placement

UI generates one `crypto.randomUUID()` Idempotency-Key per page
mount, kept in a `useRef` so retries reuse it; regenerates only on
`/problems/idempotency-conflict`. Server runs one transaction with
`SELECT FOR UPDATE OF products` for stock + price re-check, INSERTs
the order header, line-item snapshots (productCode / productName /
productImageS3Key / unitPriceCents frozen), status-history seed,
optional delivery-address and corporate-data snapshots, then clears
the cart. Public order number formatted `YYYY-MM-NNNNN` from a
Postgres sequence + Sofia-timezone month prefix.

### Order withdrawal (EU 2023/2673 14-day right)

Three routes on the existing `/orders/*` mount: `GET
/orders/:n/withdrawal/eligibility`, `GET /orders/:n/withdrawal`,
`POST /orders/:n/withdrawal`. Idempotent at the DB level via a
partial unique index on `complaints.order_id WHERE
reason='withdrawal'`. Two emails fire via `Promise.allSettled`:
customer acknowledgement (Sofia-timezone second-precision timestamp,
satisfies Art. 11a(2) durable medium) and admin notification. The
14-day window runs from `orders.accepted_at`. Auth-gated; no guest
flow in this slice. `/terms/withdrawal` is a server-component page
carrying the full ЗЗП withdrawal text + Annex I(B) model form.

### Storefront browsing

Home page, search, and the catch-all `/products/[...path]` route all
render from the live `@shop/api` catalog as of 2026-05-28. The
`(shop)/layout.tsx` fetches the category tree once per request and
passes it to `NavBar`; the home page parallelises that with a featured-
products fetch; the products catch-all resolves the URL against the
live tree as either (a) the virtual `new-products` view, (b) a pure
category chain, (c) a category chain plus product slug, or (d) a bare
product slug (which 301-redirects to the canonical category-prefixed
URL). Product pages emit `Schema.org` `Product` + `BreadcrumbList`
JSON-LD in an `@graph` envelope, plus per-product `generateMetadata`
with canonical URL and OpenGraph image. The header autocomplete is a
debounced (200 ms) client-side fetch to `/products?q=…&limit=5` with
AbortController-cancellation on resumed typing.

Tree-helper module: `frontend/src/lib/catalog.ts`. Pure functions over
the live tree (`resolveCategoryPath`, `findCategoryById`,
`getCategoryAncestors`, `categoryHref`, `productHref`) — no module-
level state, safe in both Server and Client Components.

Storefront fetch layer: `frontend/src/lib/api.ts` exposes typed
helpers — `fetchProducts(query, init?)`, `fetchCategoryTree()`,
`fetchProductBySlug(slug)` — backed by plain `fetch()` against
`NEXT_PUBLIC_SHOP_API_URL`. Return shapes are the concrete Zod-
inferred DTOs re-exported from `@shop/api` (`ProductsPage`,
`CategoryTree`, `ProductDetail`) so callers always get typed
results regardless of how the workspace symlink resolves on the
build machine. The earlier `hc<AppType>(baseUrl)` Hono RPC client
was removed after repeatedly hitting `Type error: 'api' is of
type 'unknown'` on `next build`: `AppType = ReturnType<typeof
buildApp>` is a deep generic chain that collapses whenever any
link degrades, taking the whole `Client<AppType>` with it. Plain
`fetch` sidesteps the type derivation entirely while keeping the
same typed response contracts.

Storefront filter sort options now map directly to the API's
`/products?sort=` enum (`featured | newest | price_asc | price_desc`).
The earlier UI-only `name_asc` option was dropped because the API does
not support it; if it comes back it must come back server-side.

Product-page JSON-LD includes `hasMerchantReturnPolicy` with the
14-day Bulgarian/EU 2023/2673 right-of-withdrawal expressed in
`schema.org` terms (`MerchantReturnFiniteReturnWindow`, 14 days,
return-by-mail, customer pays return shipping). All `@id` / `url` /
`item` URLs are absolute (resolved against `NEXT_PUBLIC_SITE_URL` —
same env var that backs `metadataBase`), satisfying Google's Rich
Results requirement that `BreadcrumbList.item` is a full URL. The
`Product.image` field is omitted entirely when a product has no
images yet, rather than emitting `image: []` which the Rich Results
test flags as a missing-required-field error.

The home banners and admin pages still render from
`frontend/src/lib/mock-data/*` — both await later slices. The
earlier `/api-demo` Hono-RPC smoke-test page was removed; the real
storefront pages are the canonical example of how to consume the
typed client from a Server Component.

### CSP violation reporting

The strict `'nonce-X' 'strict-dynamic'` CSP shipped to the frontend
is purely blocking — every XSS attempt the browser stops is invisible
to the operator unless the policy also carries a report sink. The
`POST /csp-report` route accepts both wire formats
(`application/csp-report` legacy + `application/reports+json`
modern), normalises field names, downgrades browser-extension noise
(`chrome-extension://`, `moz-extension://`, etc.) to `debug` level,
rate-limits per IP (60/min in-memory token bucket, 10K IPs tracked),
caps body size at 16 KiB, and ALWAYS returns 204 (W3C Reporting API
spec treats 2xx as success; surfacing 4xx only generates browser
console noise). Verify with `frontend/public/csp-test.html` —
three intentionally-bad CSP inputs should be blocked + reported.

### Accessibility (WCAG 2.2 AA / EAA)

The storefront conforms to WCAG 2.2 AA (EN 301 549 / European
Accessibility Act). Quick manual checks:

- **Keyboard:** load any page, press `Tab` once — the first stop is a
  **"Прескочи към съдържанието"** skip link; activating it jumps focus to
  the main content. Every interactive element shows a visible gold focus
  ring. In the header search, type ≥ 2 characters, then `↓`/`↑` move the
  highlighted suggestion, `Enter` opens it, `Esc` closes the list (it's a
  WAI-ARIA combobox).
- **Reduced motion:** turn on the OS "reduce motion" setting and reload —
  the skeleton shimmer and entry animations stop.
- **Contrast:** prices/links now use the darker `text-primary-strong`
  gold (≥ 4.5:1) instead of the brand fill gold.
- **Statement:** the EAA Annex V accessibility statement is at
  `/accessibility` (linked from the footer as "Достъпност").

Automated audit (layered — static in CI, runtime locally):

```powershell
npm --workspace shop run lint   # eslint-plugin-jsx-a11y (static, also CI)
cd frontend; npm run test:a11y  # axe-core via Playwright (boots next dev)
```

Full detail + the manual screen-reader checklist live in
`docs/ACCESSIBILITY.md`.

## Architecture decisions in force

Listed here so they don't have to be re-derived on every new slice.
Each has a fuller explanation in `docs/ARCHITECTURE.md` §13.

**Data shape:** Drizzle (not Prisma), money as integer cents via
`numeric(10,0)`, timestamps always `timestamptz`, UUIDs via
`gen_random_uuid()`, soft delete via `deleted_at`, optimistic locking
via `version` on orders, `idempotency_key` UNIQUE on orders, order
line items snapshotted at checkout.

**Auth crypto:** Argon2id `m=19456, t=2, p=1` (OWASP low-memory
profile, RFC 9106). 32-byte CSPRNG session tokens, SHA-256-hashed at
rest in `sessions.id_hash`. `__Host-shop_session` in prod,
`shop_session` in dev; SameSite=Lax, HttpOnly, Secure (prod).
Max-Age set only when `rememberMe=true`.

**Auth posture:** NIST SP 800-63B Rev. 4 password policy (≥12 chars,
≤1024, no composition rules, HIBP-screened at register / reset /
change). Constant-time login via `DUMMY_PASSWORD_HASH` for unknown
emails. Per-email brute-force lockout (5 fails in trailing 15-min
window → 15-min lockout). Two-tier middleware (`currentUser`
best-effort + `requireAuth` gate). Orphaned-cookie cleanup on every
`currentUser`-touched response.

**API shape:** Hono on Lambda (same handler runs on Node locally via
`@hono/node-server`). Zod 4 + `@hono/zod-openapi` auto-generates
OpenAPI 3.1 from the typed routes. `defaultHook` extracted to
`lib/validation-hook.ts` because it does NOT propagate from a parent
`OpenAPIHono` to sub-routers. RFC 9457 Problem Details on every
error. Cursor (keyset) pagination, opaque base64url, id tiebreaker.
ETag middleware + `Cache-Control: public, max-age=0, s-maxage=300,
stale-while-revalidate=60` on cacheable routes. Pino + JSON logs,
PII redaction, per-request child logger keyed on `X-Request-Id`.

**Frontend:** Next.js 16 thin proxy (`frontend/src/proxy.ts`, formerly
`middleware.ts`) does cookie-presence checks only — never validates
the token. Real auth happens in pages and Server Components.
`PUBLIC_ACCOUNT_PATHS` enumerates routes anonymous visitors can
reach (`/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email`, `/email-change/verify`). SSR identity bootstrap via
`getServerUser()` reads cookie via `next/headers` and embeds the
user into first paint — no auth flicker. Because every route reads
cookies on the SSR pass, **every route is dynamic** — Next.js 16
PPR / ISR are not actually exercised today; this is documented
explicitly in `docs/ARCHITECTURE.md` §5.2.

**Cart:** Two-mode — `sessionStorage` for guests (per-tab, dies with
the tab, matches the spec), server-persisted for authenticated users.
On login `POST /cart/merge` silently sums the guest cart into the
server cart (Amazon / Target / Etsy / Walmart pattern). Cart reads
always hydrate from the live `products` table — price and stock are
never snapshotted on the cart row.

**Checkout:** Single Drizzle transaction wraps `SELECT … FOR UPDATE
OF products`, stock + price + cart-empty validation, account-discount
lookup, order header insert, line-item snapshots, status-history
seed, optional delivery-address and corporate-data snapshots, cart
clearing. `Idempotency-Key` header (Stripe / MDN pattern) UNIQUE on
the order row; retries return the original order verbatim.

**CSP:** Uniform strict `'nonce-X' 'strict-dynamic'` on every HTML
document via the frontend proxy. The earlier hybrid (permissive on
catalog, strict on account) was found to be silently bypassed by SPA
soft navigation because the document's CSP is fixed at HTML document
load and reused across client-side route changes. Reasoning + rejected
design recorded in `docs/ARCHITECTURE.md` §5.2.

**Email transports:** `ses` (production, `@aws-sdk/client-sesv2`,
region-pinned to `eu-central-1` for GDPR), `console` (dev — prints
payload + a `VERIFY URL ⇒` line), `stub` (in-memory recorder for
tests). Selected by `EMAIL_TRANSPORT` env. Constructed lazily on
first send, then memoised — keeps Lambda cold-start budget tight.

**Email send posture:** best-effort, never blocking. A failed
verification / reset / withdrawal-acknowledgement email logs the
error and continues; the user can recover via resend.

**Token cryptography (verification, reset, email-change):** 32-byte
CSPRNG → base64url, SHA-256-hashed in `*_tokens.token_hash`,
single-use (`consumed_at`), validity 24h for signup, 1h for reset
and email-change. Bad / expired / consumed all return the SAME
generic 400 — no enumeration of token state.

**Enumeration resistance by contract:**
`POST /auth/forgot-password`, `POST /auth/email-change/request`, and
the responses for unknown vs registered emails on `/auth/login` and
`/auth/register` all return identical bodies in every internal
outcome (happy path / unknown / rate-limited / send failure). The
only non-resistant 4xx branches are explicit user errors the user
can already see (wrong current password, new == current).

## Known gaps

What's documented elsewhere but doesn't exist or has drifted from
reality, as of 2026-05-26:

- **`infra/` directory** — referenced throughout the docs; not
  created. Mentioned in `docs/COMPLIANCE.md` Pillar 1 as IaC ⚠️
  (downgraded from ✅ on 2026-05-26 after audit).
- **`admin-api` Lambda** — referenced in `docs/ARCHITECTURE.md` §3.4;
  not created. All `/admin/*` frontend pages render mock data.
- **`scheduler-fn` Lambda** — referenced in §3.8; not created.
  Three cron rules (daily catalog backup, hourly pickup expiry,
  daily unverified-account cleanup) are documented design but do
  not run.
- **Order status update wire-up** — the template and helper exist
  (`backend/email/src/templates/order-status-update.ts` + `lib/order-emails.ts`),
  but admin status transitions today still happen via direct DB updates,
  so the helper is not yet called from any route. Ships with the
  `admin-api` slice.
- **Customer MFA (TOTP / WebAuthn)** — schema exists
  (`mfaRecoveryCodes` table), no flow. Roadmap item, growth-stage.
- **Admin auth (TOTP)** — the architecture doc treats this as
  shipped (mandatory TOTP MFA on a separate subdomain). The schema
  carries `totp_secret` columns; no admin auth flow exists in the
  frontend or `shop-api`. The admin login page at `/admin/login`
  is a stub.
- **Banner slides API** — the home-page carousel still imports from
  `frontend/src/lib/mock-data/banners.ts`. A real `banner_slides`
  endpoint + admin CRUD ships with the admin-api slice.
- **Courier-office picker** — the checkout step renders Bulgarian
  Econt/Speedy offices from `mock-data/courier-offices.ts`. Real
  ingestion (either a one-off seed from the carrier APIs or a
  cron-refreshed table) is a future slice.
- **Distributed tracing** — `docs/ARCHITECTURE.md` §15 item 18
  identifies ADOT as the path. Not added. This is the last concrete
  OWASP A09 gap.
- **SQS retry queue for SES** — `docs/ARCHITECTURE.md` §15 item 21.
  Not added. Closes the EU 2023/2673 Art. 11a(2) durable-medium +
  Art. 8(7) confirmation-of-contract audit margins on email-send
  failure.
- **DR drill** — procedure documented, never executed.
- **Status page, formal SLOs in YAML, burn-rate alarms, DORA
  metrics** — all roadmap items in §15.

## Recommended next steps

In priority order (also tracked in `docs/ARCHITECTURE.md` §15):

1. **First production deploy.** Until at least one Amplify deploy
   and one Lambda deploy have actually run, the entire architecture
   is hypothesis. Create a minimal `infra/` with the Terraform that
   provisions: Amplify app, `shop-api` Lambda, Lambda function URL,
   CloudFront, ACM cert, SSM Parameter Store entries, CloudWatch
   log group, 5 alarms. 1–2 days.
2. **ADOT distributed tracing.** Closes the OWASP A09 + NIST CSF
   Detect gap. ~1 day. Becomes the foundation for the first real
   DR drill.
3. **First real DR drill** against a Neon PITR branch. Write up the
   timestamped result. 2 hours including doc.
4. ~~**Address book CRUD.**~~ ✅ Shipped 2026-06-01. `/addresses` CRUD
   (list / create / PATCH / soft-delete) + `/account/addresses` UI,
   linked from the profile. Activated the previously-dead `addresses`
   table that the GDPR export and account-deletion already referenced.
   28 integration tests.
5. **SQS retry queue for SES.** 4 hours. Closes the EU 2023/2673
   durable-medium audit margin before June 19, 2026. With the
   order-confirmation email now wired into `POST /orders`, this is the
   single remaining lift to take that compliance row from "wired but
   best-effort" to "wired with a durable retry queue".
6. ~~**Real storefront browsing.**~~ ✅ Shipped 2026-05-28. Home page,
   `/search`, `/products/[...path]`, and the header autocomplete all
   render from the live `@shop/api` catalog. Banner slides remain on
   mock data (no banners endpoint); admin pages remain on mock data
   (no admin-api).
7. **Admin-api Lambda + first admin slice.** Pick the highest-leverage
   admin slice (probably orders, so the manual `status='accepted'`
   psql can go away). Requires admin auth flow — likely TOTP per the
   spec, but a password-only first cut may be acceptable for a single
   admin behind WAF until customer demand justifies the MFA work.
   2–3 days.

Items currently described as "shipped" but actually pending
(admin-api, scheduler-fn, infra) should be brought into reality
before any further "growth-stage" items (customer MFA, multi-region,
SLSA L3, Cloudflare proxy swap).

## Browsing the API

The OpenAPI contract is generated from the `@hono/zod-openapi` routes
and served at http://localhost:3001/openapi.json in dev (or behind
your local API host). Swagger UI is not currently mounted; consume the
JSON directly or use any external viewer. Note: although `@shop/api`
exports a Hono RPC `AppType`, the frontend deliberately does **not**
use `hc<AppType>()` — it calls the API with plain `fetch` plus the
concrete Zod-inferred DTOs re-exported from `@shop/api`, because
`hc<AppType>` collapses to `unknown` under `next build` (see the
rationale header in `frontend/src/lib/api.ts`).

## License

No public license declared; this is a single-owner private codebase.
Contact the owner before forking or redistributing.
