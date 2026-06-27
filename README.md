# Best-Online-Shop-Ever

[![CI](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/actions/workflows/ci.yml)

Bulgarian-language B2C and B2B e-commerce platform. Cash on delivery
or pay-at-store only — no card data. Single-tenant, single-admin.
Target deployment is AWS Frankfurt (`eu-central-1`) for GDPR data
residency. As of 2026-06-07 the `infra/` Terraform is **validated by a
successful end-to-end `terraform apply`** — a live deploy returned HTTP
200 through CloudFront → OAC → Lambda — but no *maintained* production
environment exists yet (no custom domain, schema, or frontend). See the
[Deployment status](#deployment-status) section below for an honest read
on what is shipped, what deploys, and what is still a roadmap item.

## Documentation map

Five docs. Read them in this order if you're new:

| Doc | What's in it | When to read |
|---|---|---|
| [`README.md`](./README.md) (this file) | Onboarding, local dev, current status, decisions in force | First |
| [`docs/README.md`](./docs/README.md) | Functional / product spec, **in Bulgarian** — what the shop does | To understand the product |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Single technical reference: layers, request lifecycle, security, reliability, observability, supply chain, cost, operations, roadmap, forward-looking design considerations | To understand how it's built |
| [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) | Standards-by-standards matrix (NIST CSF 2.0, OWASP Top 10 2025, OWASP ASVS 6.0, NIST SP 800-63B-4, SLSA, CIS Controls v8.1, GDPR, EU Directive 2023/2673, WCAG 2.2). Auditor-facing | To answer "are we compliant with X?" |
| [`docs/INCIDENT-RESPONSE.md`](./docs/INCIDENT-RESPONSE.md) | Incident-response playbook: SEV1–4 severity model, detect→recover lifecycle, scenario playbooks, the GDPR Art. 33/34 breach track (Bulgarian CPDP), postmortem + breach-register templates | When something breaks — or to prove Respond/Recover + breach-notification readiness |

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
├── infra/                Terraform IaC for the first AWS deploy — live-apply-validated 2026-06-07 (deploy returned 200 end-to-end); see infra/README.md
├── .github/workflows/    CI: typecheck, lint, tests, npm-audit (6 jobs in ci.yml) + CodeQL SAST + SBOM/Sigstore + infra (fmt/validate/tflint/checkov)
├── .github/dependabot.yml  Automated dependency updates — npm + Actions + Terraform + Docker-Compose, grouped + cooldown-gated
└── docs/
    ├── README.md         Functional spec (Bulgarian)
    ├── ARCHITECTURE.md   Technical reference + roadmap + forward-looking design
    ├── COMPLIANCE.md     Standards matrix
    ├── ACCESSIBILITY.md  WCAG 2.2 AA / EAA conformance + audit + manual checklist
    └── INCIDENT-RESPONSE.md  Incident playbook + GDPR Art. 33/34 breach track + templates
```

`infra/` now exists — a complete, statically-validated Terraform stack
for the first AWS deploy (it has **not** been applied yet; that needs
AWS credentials). See `infra/README.md`.

Still not present in the repo (mentioned in `docs/ARCHITECTURE.md` as
future work):

- `backend/admin-api/` — admin Lambda. There is no separate admin-api
  Lambda yet: admin **authentication** (`/admin/auth/*`) and the admin CRUD
  slices shipped so far — **order management** (`/admin/orders/*`, 2026-06-10),
  **category management** (`/admin/categories/*`, 2026-06-15), and **product
  management** (`/admin/products/*`, backend 2026-06-22) — live in `shop-api`
  as portable `routes/admin/*` modules. The `/admin/products` **frontend** page
  is still mock pending a wiring slice; the REMAINING admin CRUD flows
  (customers, banners, settings, archive) are still stubbed on the frontend
  with mock data.
- `scheduler-fn` — the scheduled-jobs Lambda (three cron rules: daily
  catalog backup, hourly pickup expiry, daily unverified-account
  cleanup + retention prune). **Shipped 2026-06-12** — there is no
  separate directory: the jobs live in `backend/shop-api/src/jobs/*`
  (they are stateful DB sweeps, so they belong to the stateful
  package) and build into their own pure-JS Lambda artifact via
  `npm --workspace @shop/api run build:scheduler` → `dist-scheduler/`.
  Locally runnable: `npm --workspace @shop/api run job -- <name>`.

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
npm --workspace @shop/auth  run test   # 70 unit tests (Argon2, sessions, HIBP, TOTP, recovery codes, AES-GCM, challenge)
npm --workspace @shop/email run test   # 74 unit tests (14 templates + 4 transports + queue envelope/consumer)
npm --workspace @shop/api   run test   # full integration suite (379 cases) vs shop_test DB
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
| Database | Local Docker Postgres 17 for dev/CI; a Neon test branch now exists (all five migrations `0000`–`0004` applied 2026-06-13) and backs the live scheduler drills. Not yet a *maintained* prod DB (no custom domain/frontend in front of it). Runtime uses the Neon serverless WebSocket driver (HTTP for queries, WebSocket for transactions) |
| Email | `console` transport locally; four transports total (`sqs`/`ses`/`console`/`stub`). SES production domain DNS (DKIM + MAIL FROM + DMARC) not configured — live sends so far use a sandbox-verified email identity |
| Email queue (SQS + `email-fn`) | **Live-validated (2026-06-12)** — enabled on the running test stack; real SES delivery plus the DLQ → alarm → redrive drill |
| CloudFront + OAC | Provisioned on the live test stack (2026-06-07 apply) |
| WAF / Route 53 | Opt-in flags, off — Cloudflare is the documented preference (§10 cost model) |
| Admin authentication (TOTP MFA) | **Shipped end-to-end** — `shop-api` `/admin/auth/*` + the `/admin` frontend `AdminAuthGate` (login → MFA → enrolment) |
| Admin order management | **Shipped end-to-end (2026-06-10)** — `shop-api` `/admin/orders/*` (list + filters + search, detail + history, state-machine status transitions with optimistic locking + customer emails, CSV export) + the real `/admin/orders` UI |
| Admin category management | **Shipped end-to-end (2026-06-15)** — `shop-api` `/admin/categories/*` (tree with counts, create, rename/move with cycle prevention + optimistic locking, sibling reorder, deletion-impact preview, cascade soft-delete writing 301 `redirects` + `admin_audit_log`) + the real `/admin/categories` UI |
| Admin product management | **Backend shipped (2026-06-22)** — `shop-api` `/admin/products/*` (offset list + filters + search, create with auto-slug + SKU/slug uniqueness spanning archived rows, detail with active-order count, edit/move/re-image with `updatedAt` optimistic locking, within-category reorder, soft-delete writing a 301 `redirect`, restore) + `admin_audit_log`. Activates the dormant `products` write surface + `product_images` table. **Frontend `/admin/products` page still mock** — wiring is the follow-up |
| Guest checkout + order tracking | **Shipped end-to-end (2026-06-16)** — the spec's "Гост" role (orders without an account). `shop-api` `/guest/orders` (anonymous checkout, 256-bit capability token) + `/track/:token` (view, cancel-while-processing, 14-day withdrawal) + `/track/find` (rate-limited lost-link resend) + the public `/track/[token]` & `/track/find` UI. Checkout no longer forces login (`POST /orders/:n/cancel` also added for account customers). No migration — activates the dormant `orders.guest_track_token` column |
| Image-upload pipeline | **Backend + infra shipped (2026-06-22, roadmap item 46)** — `shop-api` `/admin/uploads` mints a **presigned POST** (browser → S3 directly, policy-pinned size + type) + `/admin/uploads/status`; the **assets-fn** validator Lambda magic-byte-checks each upload and promotes only genuine images to a CloudFront+OAC-served `uploads/` prefix (deletes spoofs). `infra/assets.tf` (private assets bucket, OAC distribution, S3→Lambda notification, least-priv IAM) behind `enable_asset_uploads`. Activates every dormant image key the catalog stores. **Frontend:** reusable client shipped (`lib/uploads/`); wiring the widget into the product/category/banner editors is the follow-up. No migration |
| `admin-api` Lambda | Not built (admin auth + the orders slice currently live in `shop-api`; extract when the admin CRUD surface grows) |
| `scheduler-fn` Lambda | **Shipped 2026-06-12, live-validated 2026-06-13** (roadmap item 23) — jobs in `@shop/api` `src/jobs/*` + own pure-JS bundle (`build:scheduler`) + `infra/scheduler.tf` (EventBridge Scheduler, 3 Sofia-time crons, delivery DLQ, backup bucket, 2 alarms) behind `enable_scheduler`. All three `aws lambda invoke` drills passed against the Neon test branch; the catalog-backup drill also caught a prod-only bug (the `neon-http` driver can't run `db.transaction(...)`) now fixed by the Neon serverless WebSocket driver — see [decisions](#architecture-decisions-in-force). Runbook in `infra/README.md` |
| Distributed tracing (OpenTelemetry) | **Shipped 2026-06-13 (roadmap item 18)** — `shop-api` emits OTel traces behind `ENABLE_TRACING`: `@hono/otel` request spans + undici/fetch downstream spans + Pino `trace_id`/`span_id` log↔trace correlation. Exports OTLP to AWS X-Ray via the ADOT collector layer (`enable_tracing` + `adot_collector_layer_arn`), or any OTLP backend. Closes the last OWASP A09 / NIST CSF Detect gap. App-level instrumentation + correlation unit-tested and harness-verified against the real libraries (incl. a clean esbuild bundle); live X-Ray export validated on deploy. Runbook in `infra/README.md` → "Tracing runbook" |
| SLOs + burn-rate alerting (OpenSLO) | **Shipped 2026-06-14 (roadmap items 24/25)** — `infra/slos.yaml` (OpenSLO v1: availability 99.9%, order-success 99.9%, p95 latency <1000ms) + `infra/slo.tf` multi-window multi-burn-rate composite alarms over CloudWatch Logs metric filters on the `request_end` log line. Behind `enable_slo_alarms` (default off); requires `log_level = "info"` (plan-time precondition). Defined + apply-ready; awaits live traffic to exercise the budgets. Runbook in `infra/README.md` → "SLO + burn-rate runbook" |
| Terraform / IaC | **Live-apply-validated** (`infra/`) — a successful end-to-end `terraform apply` (2026-06-07) returned HTTP 200 through CloudFront→OAC→Lambda; fmt/validate/tflint/checkov green. A maintained prod env (domain + migrated schema + frontend) is the next step |
| SEO / crawlability (sitemap, robots, 301s) | **Shipped end-to-end (2026-06-16)** — dynamic `/sitemap.xml` (live catalog with accurate `lastmod`) + `/robots.txt` (2026 AI-crawler policy: block training bots, allow search/retrieval; private routes disallowed) + **serving the 301 `redirects`** the category cascade-delete writes (closes a half-open loop: deleted URLs were returning 404 instead of 301). New public `shop-api` `GET /sitemap` + `GET /redirects/resolve`; storefront `app/sitemap.ts` + `app/robots.ts`; redirect served on the catch-all's would-be-404 path. No migration |

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
  `/orders/:orderNumber/withdrawal/eligibility`,
  `/orders/:orderNumber/cancel` (customer-initiated cancel, `processing` only)
- **`/guest/orders`** — **guest checkout (2026-06-16)**, anonymous (no
  `requireAuth`). Cart carried in the body (guests have no server cart),
  contact + delivery snapshotted onto the order, no account discount, per-IP
  anti-abuse rate limit (**distributed — Postgres-backed since 2026-06-19, so it
  holds across Lambda containers**), `Idempotency-Key` replay. Returns the order
  plus a 256-bit `trackToken` (the spec's "Гост" capability URL).
- **`/track/:token`** — **guest order tracking (2026-06-16)**, anonymous,
  token-authenticated: `GET /track/:token` (status + details + timeline +
  shop contact at shipped/ready), `POST /track/:token/cancel` (cancel while
  `processing`), `GET|POST /track/:token/withdrawal[/eligibility]` (the 14-day
  right via the tracking page), `POST /track/find` (lost-link resend, **3/hour/
  IP**, enumeration-resistant — the cap is enforced **cluster-wide** via the
  Postgres-backed limiter, not per-container). Malformed/unknown tokens →
  uniform `404`.
- `/addresses`, `/addresses/:id` — customer address-book CRUD
  (list / create / partial-update / soft-delete). `requireAuth`-gated,
  per-user ownership-scoped, 4-digit Bulgarian postal-code validation,
  20-address cap. Activates the `addresses` table the GDPR export and
  account-deletion already reference.
- `/admin/auth/*` — **admin authentication with mandatory TOTP MFA**
  (AAL2: password + RFC 6238 time-based OTP). Two-step so no session is
  ever issued before both factors pass: `POST /login` (password →
  signed `mfa_required` / `enrollment_required` challenge), `POST /mfa`
  (challenge + 6-digit TOTP or single-use recovery code → admin
  session), `POST /mfa/setup` + `POST /mfa/setup/confirm` (first-login
  TOTP enrolment → 10 single-use recovery codes, shown once),
  `POST /logout`, `GET /me` (`requireAdmin`-gated). Stricter posture
  than customer auth: 30-min / 5-fail lockout, 30-min session idle, the
  TOTP secret AES-256-GCM-encrypted at rest, a replay guard that makes
  each code single-use even inside its skew window, and a uniform `404`
  on the admin surface for non-admins (no enumeration). Activates the
  dormant `mfa_enabled` / `mfa_secret_encrypted` / `mfa_recovery_codes`
  columns the schema has carried since the first migration. See the
  [Admin authentication](#admin-authentication-totp-mfa) smoke test.
- `/admin/orders/*` — **admin order management** (2026-06-10), the
  first real admin CRUD slice, `requireAdmin`-gated (uniform `404` for
  non-admins): `GET /admin/orders` (offset-paginated list, 25/page with
  total count; filters: status, payment method, customer type,
  Europe/Sofia date range; search across order number / email / phone /
  company name), `GET /admin/orders/:orderNumber` (full detail incl.
  line-item snapshots, delivery + corporate snapshots, the
  `order_status_history` audit timeline, and the server-computed
  `allowedTargets`), `POST /admin/orders/:orderNumber/status` (the spec
  §7 state machine validated server-side; `expectedVersion` optimistic
  locking → `409 /problems/order-version-conflict` for a stale tab;
  illegal hop → `409 /problems/invalid-status-transition`; courier +
  tracking required for `shipped`, future `pickupDeadline` for
  `ready_for_pickup`; audit entry in the same transaction; the
  Bulgarian `order-status-update` email fires best-effort on every
  customer-visible hop — `returned` is silent by design), and
  `GET /admin/orders/export.csv` (filter-aware CSV: RFC 4180, UTF-8
  BOM for Excel Cyrillic, OWASP formula-injection escaping). Retires
  the manual `UPDATE orders SET status=…` psql.
- `/admin/categories/*` — **admin category management** (2026-06-15), the
  second admin CRUD slice, `requireAdmin`-gated (uniform `404`): `GET
  /admin/categories` (full live tree with per-node product + descendant
  counts), `POST /admin/categories` (create — slug auto-derived from the
  Bulgarian name and appended to the end of its layer; slug unique within a
  parent, with root-slug uniqueness enforced app-side), `PATCH
  /admin/categories/:id` (rename / re-image / **move** with cycle
  prevention; optimistic-locked on `updatedAt` via `SELECT … FOR UPDATE`
  → `409 /problems/category-version-conflict` for a stale tab), `POST
  /admin/categories/reorder` (rewrite one layer's `display_order`; the
  supplied id set must equal that layer or `409`), `GET
  /admin/categories/:id/deletion-impact` (subcategory + product counts plus
  how many products sit in active orders — powers the confirm dialog), and
  `DELETE /admin/categories/:id` (cascade soft-delete of the subtree + its
  products, writes 301 `redirects` rows to the surviving parent / home,
  requires `confirmConsequences: true`). Writes the first `admin_audit_log`
  rows (GDPR Art. 30). Un-mocks the `/admin/categories` screen.
- `/admin/products/*` — **admin product management** (2026-06-22), the
  third admin CRUD slice, `requireAdmin`-gated (uniform `404`): `GET
  /admin/products` (offset-paginated list, 25/page with total count;
  filters: category, stock status, active / archived / all; search across
  name + SKU; sort by newest / oldest / price / name), `POST
  /admin/products` (create — slug auto-derived from the Bulgarian name,
  appended to the end of its category; SKU + slug uniqueness enforced across
  archived rows too, so a clean `409` instead of a DB constraint `500`;
  ordered image set supplied by S3 key), `GET /admin/products/:id` (full
  detail incl. the ordered images, category breadcrumb, and the active-order
  count that powers the delete warning; serves archived rows too), `PATCH
  /admin/products/:id` (edit / re-price / re-stock / **move** / re-image,
  optimistic-locked on `updatedAt` via `SELECT … FOR UPDATE` → `409
  /problems/product-version-conflict`; `409 /problems/product-slug-conflict`
  / `…-code-conflict` on a collision), `POST /admin/products/reorder`
  (rewrite one category's product `display_order`; the supplied id set must
  equal that layer or `409`), `DELETE /admin/products/:id` (soft-delete +
  a 301 `redirects` row to the surviving category or home, mirroring the
  category cascade; requires `confirmConsequences: true`), and `POST
  /admin/products/:id/restore` (un-archive + clear the redirect, re-homing an
  orphan whose category was removed to uncategorised). Every state change
  appends an `admin_audit_log` row (GDPR Art. 30). **Activates the dormant
  `products` write surface + the `product_images` table** (the catalog could
  previously only be seeded via SQL). Backend only this slice — the
  `/admin/products` frontend page stays on mock data pending a wiring
  follow-up; images are stored as S3 keys exactly like the categories slice
  (the presigned direct-to-S3 upload pipeline that finally puts bytes behind
  those keys shipped 2026-06-22 as `/admin/uploads`, below — see
  `docs/ARCHITECTURE.md` §13).
- `/admin/uploads/*` — **admin image uploads (2026-06-22)**, the image-upload
  pipeline (roadmap item 46), `requireAdmin`-gated (uniform `404`): `POST
  /admin/uploads` (mint a short-lived **presigned POST** so the browser uploads
  one image straight to S3 — never through Lambda; the policy pins the exact
  server-chosen key, a `content-length-range`, and the `Content-Type`; `kind` ∈
  `products | categories | banners` selects the key folder) and `GET
  /admin/uploads/status` (has the uploaded key been validated + promoted yet?).
  The bytes land in `pending/`; the **assets-fn** validator Lambda magic-byte-
  checks them and **promotes only genuine images** to the CDN-served `uploads/`
  prefix (deleting spoofs — a declared `Content-Type` is never trusted as proof).
  The admin saves the returned `storedKey` on the product/category/banner exactly
  as those routes already accept image keys. **Activates every dormant image key
  the catalog stores** (the catalog could previously only be seeded with keys
  pointing at nothing). Behind `enable_asset_uploads` (returns `503
  /problems/uploads-not-configured` when unset); no migration; one new
  first-party dep (`@aws-sdk/s3-presigned-post`). Full rationale in
  `docs/ARCHITECTURE.md` §13.
- `/csp-report` — accepts both legacy `application/csp-report` and
  modern `application/reports+json`. Anonymous (intentionally outside
  the auth chain).
- `/consent` — server-side cookie-consent receipts (GDPR Art. 7(1)
  demonstrability). `POST` records an append-only receipt and mints an
  opaque, strictly-necessary `visitor_id` cookie; `GET` returns the
  visitor's current choice. Anonymous (like `/csp-report`). Activates
  the `cookie_consents` table the schema has modelled since the initial
  migration; the banner now writes here, not just to `localStorage`.
- **`/sitemap`** — **sitemap source data (2026-06-16)**, anonymous. Every
  non-deleted category + product as a canonical storefront path with its real
  `updated_at` `lastmod`, built server-side (same URL helpers the storefront
  uses, so a sitemap URL can never drift from the served URL). Backs the
  storefront `/sitemap.xml`. ETag + 1h edge cache.
- **`/redirects/resolve`** — **301 redirect serving (2026-06-16)**, anonymous.
  `GET /redirects/resolve?path=…` looks up a deleted URL in the `redirects` table
  (written by the admin category cascade-delete) and follows any chain to the
  final surviving target. The storefront catch-all calls it on the would-be-404
  path. Closes the half-open loop where deleted category/product URLs returned
  404 instead of 301 (SEO link-equity leak).
- `/health`, `/openapi.json`

Test counts as of 2026-06-22, by `it`/`test` block: addresses 28,
admin-auth 17, **admin-orders 26**, **admin-categories 39**, **admin-products 35**,
**admin-uploads 12** (the presigned-upload route — requireAdmin, allowlist + size
+ kind validation, the 503-when-unconfigured path, and the status poll, with the
S3 adapters injected; 2026-06-22),
auth 48, cart 30, categories 7,
consent 10, csp-report 25, data-export 14, email-change 21,
**error-handling 3** (the global `onError` framework-error contract — a
malformed JSON body → 400 `/problems/malformed-json`, not 500; 2026-06-22),
order-emails 5, orders 25, password-reset 19, products 15,
verification 11, withdrawal 23, **guest 23** (guest checkout +
`/track` view/cancel/withdrawal + find-my-order + authenticated
cancel, 2026-06-16), **seo 11** (sitemap data + redirect-resolve +
chain collapse + OpenAPI registration, 2026-06-16), **jobs 19** (pickup-expiry 4,
unverified-cleanup 9 — incl. the `rate_limit_counters` retention prune —
catalog-backup + dispatch 6 — the scheduler-fn sweeps, 2026-06-12/2026-06-19),
**validate-upload 7** (the assets-fn image validator: promote a genuine
JPEG/WebP, delete a spoofed content/extension mismatch, a non-image, and a
malformed key — without fetching bytes — plus the S3-event batch, 2026-06-22),
plus lib suites (phone-validation;
**email-transport-config 3** — the `EMAIL_TRANSPORT=sqs` boot contract;
**tracing 5** — the OpenTelemetry flag toggle, log↔trace correlation,
and the `@hono/otel` request span, 2026-06-13;
**guest-track 6** — the 256-bit token + the `clientIpFromXff` helper,
2026-06-16; **rate-limit-db 6** — the distributed Postgres-backed limiter:
count-to-limit, cross-instance shared budget, no over-increment, window roll,
subject isolation, fail-open, 2026-06-19; **seo 12** — the pure redirect-chain
resolver + the sitemap URL builder, 2026-06-16; **error-response 10** — the pure
framework-error classifier: malformed-JSON detection, status-honouring, RFC 9110
reason-phrase titles, and that `ApiError`/`ZodError`/unknown correctly fall
through, 2026-06-22; **product-admin 17** — the pure admin-product helpers:
slug resolution (derive vs explicit), image-list normalisation (trim / dedup /
cap / dense order), the canonical-URL builder for the soft-delete redirect, and
the three-way `new_until` resolution, 2026-06-22;
**asset-upload 24** — the pure image-upload helpers: the content-type allowlist
(no SVG/GIF), the pending/served/stored key layout + strict pending-key parse,
request validation (size cap + kind), the presigned-POST policy params, and the
magic-byte sniffer proving JPEG/PNG/WebP/AVIF pass while a spoofed/WAV/SVG/empty
head is rejected, 2026-06-22) — **556 blocks**. The
`csp-report` and `phone` suites are table-driven (`it.each`), so
`vitest run` expands them and reports **~590 cases total** (run
`vitest run` for the exact figure), all against a real `shop_test`
Postgres in CI.

### Backend (`@shop/db` schema)

31 tables, 32 FKs, 47 indexes, 10 enums, 6 migrations
(`0000_initial.sql`, `0001_orders_sequence.sql`,
`0002_complaints_withdrawal.sql`,
`0003_admin_mfa_replay_guard.sql` — adds `users.mfa_last_used_step` +
`mfa_enrolled_at` for the admin TOTP flow,
`0004_scheduler_jobs.sql` — adds the two scheduler claim markers
`orders.pickup_expired_notified_at` +
`users.unverified_deletion_warning_at` and their partial indexes,
`0005_rate_limit_counters.sql` — adds the `rate_limit_counters` table
(composite-PK fixed-window counters) backing the distributed guest
rate limiters). Idempotent seed in `backend/db/scripts/seed.ts`.

### Backend (`@shop/auth`)

Argon2id helpers (`m=19456, t=2, p=1`), session token
generation/hashing, `DUMMY_PASSWORD_HASH`, and HIBP k-anonymity
breached-password screening. Plus the admin-MFA crypto primitives
(2026-06-08): RFC 6238 **TOTP** (generate / verify with a ±1-step skew
window and a single-use replay guard), single-use **recovery codes**
(Argon2id-hashed), **AES-256-GCM** encryption of the TOTP secret at
rest, and the HMAC **challenge token** that binds the password step to
the TOTP step. 31 original unit tests across `breached-password`,
`password`, `session-tokens`, plus new suites for `totp` (validated
against the **RFC 6238 Appendix B** reference vectors), `mfa-crypto`,
`recovery-codes`, and `challenge`. Pure functions only — the stateful
half (DB lookups, replay-step persistence, lockout) lives in
`@shop/api`'s `lib/admin-mfa.ts`, so the same crypto serves shop-api,
a future admin-api, and cron lambdas.

### Backend (`@shop/email`)

Transactional email behind a common `EmailTransport` interface, with
four implementations (`ses`, `sqs`, `console`, `stub`). The `sqs`
transport (2026-06-12, roadmap item 21) is the production target: it
enqueues the rendered email onto a durable SQS queue and the
**email-fn** Lambda (`src/queue/handler.ts`, bundled by
`npm --workspace @shop/email run build:lambda`) performs the real SES
send with partial-batch retry + an alarmed DLQ — an SES outage delays
delivery instead of dropping it. The versioned queue envelope and the
consumer live in this package (`src/queue/`), so the producer/consumer
contract can never drift. **Fourteen** Bulgarian templates currently
exist:

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
    `cancelled`). **Wired since 2026-06-10**: `POST
    /admin/orders/:orderNumber/status` sends it best-effort after each
    customer-visible transition commits (`returned` is internal
    bookkeeping and intentionally silent). The `accepted` copy points
    at the 14-day withdrawal mechanism — that transition starts the
    window (`orders.accepted_at`).
12. `data-exported` — out-of-band security notice sent when a customer
    runs the GDPR Art. 15/20 self-service data export (`POST
    /auth/me/export`). Carries no payload and no link (the data went
    over the authenticated channel); directs a surprised recipient to
    secure their account, mirroring the `password-changed` pattern.
13. `pickup-expired-admin` — operations notice to the support inbox
    when a `ready_for_pickup` order's deadline passes (sent once per
    order by scheduler-fn's hourly job, 2026-06-12). Order number +
    customer contact + admin deep link; the decision stays manual per
    spec §7 — the order is never auto-cancelled.
14. `account-deletion-warning` — the day-6 „ще бъде изтрит утре"
    notice to an unverified account (scheduler-fn daily cleanup,
    2026-06-12), carrying a FRESH 24h verification link as the
    primary CTA and an explicit "no action needed if this wasn't you"
    default.

### Backend (scheduled jobs — `@shop/api` `src/jobs/*`, 2026-06-12)

Three idempotent sweeps behind one registry (`runner.ts`), invoked by
EventBridge Scheduler in production (`{"job":"…"}` static input →
`src/jobs/handler.ts`, own pure-JS bundle via `build:scheduler`) and
by hand locally (`npm --workspace @shop/api run job -- <name>
[--now=<ISO>]`):

- **`pickup-expiry`** (hourly) — claims expired `ready_for_pickup`
  orders via `pickup_expired_notified_at` (set in the same UPDATE that
  selects → exactly-once under at-least-once scheduling) and sends the
  admin the spec-§7 notice. The order is NOT transitioned. A refused
  send surrenders the claim so the next hour retries.
- **`catalog-backup`** (03:00 Sofia) — date-keyed
  (`catalog/<YYYY-MM-DD>.json`, Sofia calendar) JSON snapshot of the
  four catalog tables — soft-deleted rows included, zero personal
  data — uploaded to the versioned 90-day-lifecycle bucket and indexed
  in the previously-dormant `catalog_backups` table (one
  `kind='scheduled'` row per key; the future admin Archive page lists
  from it). Deterministic ordering keeps unchanged re-runs
  byte-identical. Fails LOUD (→ Errors alarm) if the bucket env is
  missing — a backup that silently no-ops is the worst backup.
- **`unverified-cleanup`** (04:00 Sofia) — spec-§8 GDPR
  Art. 5(1)(e) sweep: day-6 warning email (claim marker
  `unverified_deletion_warning_at` + fresh 24h token), day-7 HARD
  delete of unverified customers (no orders ⇒ nothing legally
  retained; `role='customer'` + `NOT EXISTS(orders)` rails keep the
  bootstrap admin and any anomaly out), the 180-day
  `login_attempts` retention prune the schema promised since 0000,
  plus (2026-06-19) a `rate_limit_counters` prune that drops counter
  rows from windows older than 2 days — the one janitor that keeps the
  distributed rate-limiter table bounded without its own cron.

Migration `0004_scheduler_jobs` adds the two claim markers + their
partial indexes. Job failures propagate (async invoke → Lambda
retries → `scheduler-fn-errors` alarm); there is no job-level DLQ
because the next cron tick re-covers the same work by design.

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

Real **guest checkout** wired end-to-end (2026-06-16): `/checkout` no longer
bounces anonymous visitors to login — the review step branches on auth and
places guests through `POST /guest/orders`, landing them on
`/track/[token]?confirm=1`. The public `/track/[token]` page renders status,
timeline, shop contact (at shipped/ready), an inline cancel-while-processing
flow, and the 14-day withdrawal form; `/track/find` (linked in the footer) is
the lost-link recovery page. Typed client in `frontend/src/lib/track/`. The
`/track` route is served `robots: noindex` + `referrer: no-referrer` so the
capability token never leaks via indexing or the Referer header.

**SEO / crawlability** wired end-to-end (2026-06-16): `app/sitemap.ts` emits a
dynamic `/sitemap.xml` from the live catalog (`GET /sitemap`) with accurate
`lastmod`, degrading to static-only if the API is briefly unreachable;
`app/robots.ts` emits `/robots.txt` with the 2026 AI-crawler policy (block
training bots, allow search/retrieval), the private-route disallows, and the
sitemap pointer — and `Disallow: /` on any non-production host. Deleted
category/product URLs now **301 to the surviving target** instead of 404ing:
the catch-all `/products/[...path]` resolves the `redirects` table (via
`GET /redirects/resolve`) on its would-be-404 path, so the happy path is
untouched. The redirect appends a `#moved` fragment so the destination shows the
spec's „вече не е наличен" toast (`MovedNotice`) — a fragment, not a query param,
so the 301 target stays canonically clean for crawlers. Typed client in
`frontend/src/lib/seo/`.

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
- **Most admin pages** under `/admin/*` (dashboard tiles, banners,
  customers, archive, settings) render mock
  data — no admin API behind those screens yet. **Exceptions:** the
  admin **orders** screens (`/admin/orders` + `/admin/orders/[orderNumber]`,
  real since 2026-06-10) and the admin **categories** screen
  (`/admin/categories`, real since 2026-06-15), backed by `/admin/orders/*`
  and `/admin/categories/*` on `shop-api`. The admin **products** screen
  still renders mock data, but its backend API (`/admin/products/*`) shipped
  2026-06-22 (full CRUD + reorder + archive/restore + tests) — only the
  frontend wiring remains.

Category-tree browsing (`/products/[...path]`) and search (`/search`)
moved off mock data on 2026-05-28 — see [Storefront browsing](#storefront-browsing)
below.

### Continuous integration

`.github/workflows/ci.yml` runs six parallel jobs on every pull
request and every push to `main`:

| Job | What it runs | Service |
|---|---|---|
| `typecheck` | `tsc --noEmit` across `@shop/db`, `@shop/auth`, `@shop/email`, `@shop/api` | — |
| `lint` | `next lint` on the frontend — includes the hardened `eslint-plugin-jsx-a11y` accessibility rules (the static layer of the WCAG audit) | — |
| `auth-tests` | Unit tests in `@shop/auth` | — |
| `email-tests` | Unit tests in `@shop/email` (templates + transports, SES mocked) | — |
| `api-tests` | Integration tests in `@shop/api` | Postgres 17 |
| `audit` | `npm audit` — informational all-severity (non-blocking) + a blocking gate on **critical** advisories in the production tree (`--omit=dev --audit-level=critical`) | — |

Dependency *upkeep* is automated separately by **Dependabot**
(`.github/dependabot.yml`): grouped, cooldown-gated version-update PRs
across npm, GitHub Actions (incl. the SHA pins), Terraform, and the
Docker-Compose Postgres image. See `docs/ARCHITECTURE.md` §9.6 for why
Dependabot rather than Renovate.

`.github/workflows/codeql.yml` runs CodeQL SAST on every PR, every
push to `main`, and a Sunday 03:00 UTC weekly cron. `security-extended`
query suite on JavaScript/TypeScript plus the `actions` query pack on
workflow YAML.

`.github/workflows/sbom.yml` generates a CycloneDX 1.6 SBOM per
workspace using `@cyclonedx/cyclonedx-npm`, signs each one via
`actions/attest-build-provenance` (GitHub OIDC → Sigstore Fulcio →
Rekor transparency log), and attaches them to releases. The verifier
recipe is in `docs/ARCHITECTURE.md` §9.5.

`.github/workflows/infra.yml` gates the `infra/` Terraform on every PR
that touches it: `terraform fmt -check`, `terraform validate` (root +
bootstrap stacks), `tflint` (AWS ruleset), and `checkov` (with the
accepted-findings register in `infra/.checkov.yaml`). Terraform and
TFLint are installed from version-pinned release archives rather than
extra marketplace actions, so `actions/checkout` stays the only
third-party action. This is a deploy-less gate — `terraform apply`
runs from a separate privileged path (OIDC deploy role), never here.

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

The home banners and the non-orders admin pages still render from
`frontend/src/lib/mock-data/*` — they await later slices (the admin
**orders** pages went real on 2026-06-10). The earlier `/api-demo`
Hono-RPC smoke-test page was removed; the real storefront pages are
the canonical example of how to consume the typed client from a
Server Component.

### Admin authentication (TOTP MFA)

The single admin account authenticates with a password **and** a TOTP
code (AAL2). There is no self-service admin registration — bootstrap the
one admin out of band, then enrol TOTP on first login.

One-time setup (PowerShell, from the repo root, with the API env ready):

```powershell
# 1. Generate the two admin secrets and add them to backend\shop-api\.env
npm --workspace @shop/api run admin:create -- --print-keys
#   → copy ADMIN_MFA_ENCRYPTION_KEY and ADMIN_MFA_CHALLENGE_KEY into .env

# 2. Create the admin row (env vars preferred over flags — avoids shell history)
$env:ADMIN_EMAIL="admin@shop.bg"; $env:ADMIN_PASSWORD="a long passphrase"
npm --workspace @shop/api run admin:create
```

Then exercise the flow against `npm run api:dev` (http://localhost:3001):

```bash
# First login → enrollment_required (the admin has no TOTP yet)
curl -s -X POST localhost:3001/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@shop.bg","password":"a long passphrase"}'
#   → { "status":"enrollment_required", "challenge":"…" }

# Provision a secret (returns an otpauth:// URI — paste into any authenticator,
# or render it as a QR). Add the secret to your authenticator app.
curl -s -X POST localhost:3001/admin/auth/mfa/setup \
  -H 'Content-Type: application/json' -d '{"challenge":"<enrol challenge>"}'
#   → { "secret":"…", "otpauthUri":"otpauth://totp/…", "challenge":"…" }

# Confirm with a live 6-digit code → MFA enabled, session cookie set,
# 10 recovery codes returned ONCE.
curl -s -X POST localhost:3001/admin/auth/mfa/setup/confirm \
  -H 'Content-Type: application/json' -d '{"challenge":"<setup challenge>","code":"123456"}'

# Subsequent logins: /login → status "mfa_required" → POST /mfa with the
# current 6-digit code (or a recovery code) → admin session cookie.
```

Things worth checking: replaying the same TOTP code twice is rejected
(single-use within the window); a recovery code works once and then
can't be reused; five wrong attempts lock the email for 30 minutes;
`GET /admin/auth/me` returns `404` (not `401`) without an admin session
so the surface isn't confirmable. The full behaviour is covered by
`backend/shop-api/tests/routes/admin-auth.test.ts` and the `@shop/auth`
unit suites (`totp`, `mfa-crypto`, `recovery-codes`, `challenge` —
including the RFC 6238 Appendix B reference vectors).

> **Note — one-time migration step.** This slice adds migration
> `0003_admin_mfa_replay_guard` (two columns on `users`). Run
> `npm run db:reset` (or `cd backend/db && npm run db:migrate`) before
> the API/tests so the new columns exist.

### Admin order management

With the admin signed in (previous section), open http://localhost:3000/admin/orders.
The list renders from `GET /admin/orders` — newest first, 25/page,
with status / payment / customer-type / date filters, a search box
(order number, email, phone, company), pagination controls top and
bottom, and an **Експорт CSV** button that downloads the current
filter view (UTF-8 BOM — Cyrillic opens correctly in Excel).

Place an order as a verified customer first (see
[Order placement](#order-placement)), then click **Виж** on it:

- The detail page shows the line-item snapshots, delivery/corporate
  data, and the status timeline (`order_status_history`).
- The action buttons are exactly the server's `allowedTargets` for the
  order's status × payment method (spec §7 state machine). A
  cash-on-delivery order in „Обработва се" offers **Изпрати поръчката**
  (requires courier + tracking number) and **Откажи поръчката**; a
  pickup order offers **Маркирай като готова за вземане** (requires a
  future deadline) instead.
- Every action goes through an inline confirmation step (order summary
  + Потвърди / Назад), per the spec's irreversibility rule.
- Each customer-visible transition queues the Bulgarian
  `order-status-update` email — watch `api:dev`'s stdout under the
  `console` transport (the `shipped` email carries the courier +
  tracking number; the `accepted` one points at the withdrawal right).
- **Optimistic locking:** open the same order in two tabs, transition
  it in tab A, then try a transition in tab B. Tab B gets the spec's
  „Поръчката е вече актуализирана…" notice and auto-refreshes to the
  current state — the stale action never lands (`409
  /problems/order-version-conflict` under the hood; the audit history
  shows exactly one entry for the hop).
- A `ready_for_pickup` order whose deadline has passed is marked red
  with an „Изтекъл срок за вземане" warning in the list and detail.

The full behaviour is covered by
`backend/shop-api/tests/routes/admin-orders.test.ts` (26 cases).

### Admin category management

With the admin signed in, open http://localhost:3000/admin/categories.
The tree renders from `GET /admin/categories` — every live category with its
direct product count and a subcategory count. **Добави категория** creates a
root; the **Подкатегория** button on a row creates a child (the slug is
auto-derived from the Bulgarian name — „Електроника" → `elektronika` — and
stays editable). New categories append to the end of their layer; the up/down
arrows reorder siblings (`POST /admin/categories/reorder`).

**Редактирай** renames, re-images, or **moves** a category (the „Бащина
категория" dropdown lists every category except the one being edited and its
descendants, so a cycle is impossible — the server also rejects one with
`422 /problems/category-move-cycle`). Open the same category in two tabs, edit
in tab A, then save tab B → tab B gets the version-conflict notice and the
list refreshes (optimistic locking on `updatedAt` via `SELECT … FOR UPDATE`).

**Изтрий** first calls `GET /admin/categories/:id/deletion-impact` and shows
exactly what will be removed — N subcategories and M products — and, when any
of those products sit in active orders, the spec's warning („X от продуктите …
се намират в N активни поръчки. Историята на поръчките няма да бъде засегната
… snapshot …"). Deletion is gated on the „Разбирам последствията" checkbox.
Confirming soft-deletes the whole subtree + its products and writes 301
`redirects` rows (old category / product URLs → the surviving parent, or home
for a deleted root) — verify with `SELECT source_path, target_kind FROM
redirects;` and confirm order history is untouched (`order_items` snapshots
remain). Every action appends an `admin_audit_log` row (GDPR Art. 30).

The full behaviour is covered by
`backend/shop-api/tests/routes/admin-categories.test.ts` (39 cases).

### Admin product management

The catalog can finally be managed without raw SQL. **Backend only this
slice** — the `/admin/products` screen is still mock, so exercise the API
directly against `npm run api:dev` (an admin session cookie is required — see
[Admin authentication](#admin-authentication-totp-mfa); save it to
`cookies.txt`). On PowerShell put JSON bodies in a file and send `--data
"@body.json"` — inline `\"`-escaped JSON gets mangled by the shell.

```bash
# Create — slug auto-derives from the Bulgarian name; the SKU (code) is yours.
#   body.json: {"name":"Слушалки Сони","code":"SONY-WH-1000","priceCents":29999,
#               "categoryId":"<CAT_UUID>","images":[{"s3Key":"products/sony/main.jpg"}]}
curl.exe -s -X POST localhost:3001/admin/products -b cookies.txt \
  -H 'Content-Type: application/json' --data "@body.json"
#   → 201 { "id":"…","slug":"slushalki-soni","isNew":true,"updatedAt":"…", … }

# List — offset paging + filters + search (25/page, with a total count).
curl.exe -s "localhost:3001/admin/products?q=sony&stockStatus=in_stock&page=1" -b cookies.txt

# Edit — echo the updatedAt you last saw as the optimistic-lock token.
#   {"expectedUpdatedAt":"<updatedAt>","priceCents":24999}
curl.exe -s -X PATCH localhost:3001/admin/products/<ID> -b cookies.txt \
  -H 'Content-Type: application/json' --data "@patch.json"
#   a stale token → 409 /problems/product-version-conflict

# Archive (soft-delete) — writes a 301 from the product URL to its category,
# then verify the redirect serves (the same one the storefront catch-all reads).
#   {"expectedUpdatedAt":"<updatedAt>","confirmConsequences":true}
curl.exe -s -X DELETE localhost:3001/admin/products/<ID> -b cookies.txt \
  -H 'Content-Type: application/json' --data "@del.json"
curl.exe -s "localhost:3001/redirects/resolve?path=/products/<cat-slug>/<slug>"  # → 301 target

# Restore — un-archives and removes that redirect.
curl.exe -s -X POST localhost:3001/admin/products/<ID>/restore -b cookies.txt
```

Things worth checking: a duplicate SKU or slug → `409`
(`/problems/product-code-conflict` / `…-slug-conflict`) — even against an
*archived* product (restore it instead of recreating); moving a product to an
unknown category → `400`; `GET /admin/products/:id` returns `activeOrderCount`
so the UI can warn before archiving a product that sits in live orders (order
history is untouched regardless — `order_items` snapshot their lines). The full
behaviour is covered by
`backend/shop-api/tests/routes/admin-products.test.ts` (35 cases) plus the pure
helpers in `backend/shop-api/tests/lib/product-admin.test.ts` (17 cases).

### Image uploads (presigned POST + magic-byte validation)

The pipeline that finally puts bytes behind the catalog's image keys (roadmap
item 46). The real upload round-trip needs a deployed assets bucket
(`enable_asset_uploads`) — the full presign → S3 → validate → promote drill is in
`infra/README.md` → "Image upload runbook". What you can exercise **locally**
(no AWS):

- **Unit level:** `npm --workspace @shop/api run test` — `tests/lib/asset-upload.
  test.ts` proves the content-type allowlist (SVG/GIF rejected), the key layout,
  the presigned-POST policy params, and the **magic-byte sniffer** (real
  JPEG/PNG/WebP/AVIF heads pass; a spoofed/WAV/SVG/empty head is rejected);
  `tests/assets/validate-upload.test.ts` proves the validator **promotes** a
  genuine image and **deletes** a content/extension mismatch, a non-image, and a
  malformed key; `tests/routes/admin-uploads.test.ts` proves the route
  (requireAdmin 404, allowlist/size/kind 400s, the response shape) with the S3
  adapters injected.
- **Unconfigured path:** with no `ASSET_UPLOAD_BUCKET` set (local default),
  `POST /admin/uploads` returns `503 /problems/uploads-not-configured` — uploads
  are inert, and the catalog still renders with placeholders. That is the
  expected local-dev behaviour.

The full design rationale is in `docs/ARCHITECTURE.md` §13; the reusable browser
client is `frontend/src/lib/uploads/`.

### Guest checkout & order tracking

The spec's "Гост" role — buy, track, cancel, and withdraw with no account.
In the browser: add products to the cart while logged out, go through
`/checkout` → `/checkout/review`, fill the contact fields, click **Потвърди
поръчката**. You land on `/track/<token>?confirm=1` with a green banner; the
`console` email transport prints an order-confirmation carrying the
`…/track/<token>` link. On that page you can **Анулирай поръчката** while the
order is „Обработва се"; once an admin moves it to „Приета" the 14-day
**Подай рекламация / Върни стока** form appears. The footer's **Намери
поръчката ми (гост)** link goes to `/track/find`, which re-sends the link for a
matching order number + email (always shows the same neutral message; max
3/hour/IP — enforced cluster-wide via the Postgres `rate_limit_counters`
table, so it holds across Lambda containers, not just one).

Backend-only (no browser), against `npm run api:dev`:

```bash
# Place a guest order (use a real product id from the seed; see /products).
curl -s -X POST localhost:3001/guest/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: '"$(uuidgen)" \
  -d '{"contact":{"email":"guest@example.com","name":"Гост","phone":"0888123456"},
       "paymentMethod":"pay_at_store","items":[{"productId":"<PRODUCT_UUID>","quantity":1}]}'
#   → 201 { ..., "trackToken":"<43-char token>", "trackPath":"/track/<token>" }

curl -s localhost:3001/track/<token>            # → the tracked order
curl -s -X POST localhost:3001/track/<token>/cancel   # → 200 (status cancelled)
curl -s localhost:3001/track/zzz                # → 404 (malformed/unknown token)
```

The full behaviour is covered by
`backend/shop-api/tests/routes/guest.test.ts` and the pure-unit suite
`backend/shop-api/tests/lib/guest-track.test.ts`.

### SEO: sitemap, robots, and 301 redirects

Three site-level crawlability primitives (2026-06-16). With the frontend and API
running (`npm run api:dev`, `npm run frontend:dev`):

- **Sitemap.** Open http://localhost:3000/sitemap.xml — an `<urlset>` listing the
  home + static pages and every live category/product as an absolute URL with a
  `<lastmod>`. The data comes from the API: `curl -s localhost:3001/sitemap` →
  `{ "categories": [...], "products": [...], "generatedAt": "…" }` (canonical
  relative paths + ISO `lastmod`). Seed the catalog first (`npm run db:reset`).
- **Robots.** Open http://localhost:3000/robots.txt. In local dev (a non-https
  host) it returns a blanket `Disallow: /` so dev never gets indexed. On a real
  `https://` `NEXT_PUBLIC_SITE_URL` it returns the catalog-open policy, the
  private-route disallows (`/account /admin /checkout /cart /search /track /api`),
  the training-bot blocks (GPTBot, CCBot, ClaudeBot, Google-Extended, …), and the
  `Sitemap:` pointer.
- **301 redirect serving.** Delete a category in `/admin/categories` (this writes
  `redirects` rows). Then visit one of the now-deleted category/product URLs:
  the storefront **301s** to the surviving parent (or home) instead of 404ing,
  and shows the spec's „вече не е наличен" toast (`MovedNotice`, via a `#moved`
  fragment). Backend directly:
  `curl.exe -s "localhost:3001/redirects/resolve?path=/products/<old-path>"`
  → `{ "target": "/products/<survivor>", "statusCode": 301 }`; an unknown path → 404.

The full behaviour is covered by
`backend/shop-api/tests/routes/seo.test.ts` and the pure-unit suite
`backend/shop-api/tests/lib/seo.test.ts`; the design rationale is in
`docs/ARCHITECTURE.md` §13.

### Durable email delivery (SQS → email-fn → SES)

Local dev keeps the `console` transport, so nothing changes day-to-day.
To exercise the queue path itself:

- **Unit level:** `npm --workspace @shop/email run test` — the
  `sqs-transport` suite proves the rendered email round-trips the
  versioned queue envelope byte-for-byte (Bulgarian copy included), and
  the `queue-consumer` suite proves partial-batch semantics: one bad
  record fails alone (its batch-mates are sent exactly once), poison
  pills are failed toward the DLQ rather than dropped, and failure logs
  carry template + message ids but never a recipient address.
- **Boot contract:** `EMAIL_TRANSPORT=sqs` without `EMAIL_QUEUE_URL`
  refuses to boot (fail-fast at env parse;
  `tests/lib/email-transport-config.test.ts`).
- **Live stack:** set `enable_email_queue = true` +
  `email_transport = "sqs"` in `terraform.tfvars`, build both bundles,
  apply, then place an order — `POST /orders` returns immediately, the
  email lands via email-fn, and `email_queue_sent` appears in the
  email-fn log group. Break `EMAIL_FROM` on email-fn (or sandbox an
  unverified recipient) to watch retries park the message in the DLQ
  and the `email-dlq-depth` alarm fire; redrive from the SQS console
  afterwards. Full runbook in `infra/README.md`.

### Scheduled jobs (scheduler-fn)

The three sweeps run identically on a laptop and in production —
locally they use the `console` transport (rendered emails print to
stdout) and an injected `--now` lets you time-travel instead of
waiting six days:

```powershell
# Hourly expired-pickup check: mark an order ready_for_pickup with a
# past deadline (admin UI or psql), then:
npm --workspace @shop/api run job -- pickup-expiry
# → console prints the admin notice; orders.pickup_expired_notified_at
#   is set; re-running prints NOTHING (claimed = idempotent).

# Day-6 warning + day-7 deletion: register a fresh account, skip
# verification, then time-travel:
npm --workspace @shop/api run job -- unverified-cleanup --now=<registration time + 6.5 days, ISO>
# → warning email with a fresh verify link; run again with +7.5 days
#   → the account row is hard-deleted (cascades sessions/profile).

# Catalog backup (locally proves the loud-failure guard):
npm --workspace @shop/api run job -- catalog-backup
# → throws "CATALOG_BACKUP_BUCKET is required" by design — a backup
#   job that silently no-ops is the worst failure mode. The real
#   upload is exercised in tests (injected recorder) and live.
```

- **Unit level:** `npm --workspace @shop/api run test` — the
  `tests/jobs/*` suites (18 blocks) prove claim-then-send idempotency,
  the compensation path when the transport refuses, every deletion
  rail (verified / admin / soft-deleted / young / has-orders), the
  180-day `login_attempts` prune, Sofia-calendar date keys (incl. the
  UTC≠Sofia midnight edge), byte-identical re-runs, and the
  `catalog_backups` replace-by-key row.
- **Live stack:** `enable_scheduler = true`, build the bundle, apply —
  EventBridge Scheduler fires the three Sofia-time crons; failures
  surface on the `scheduler-fn-errors` / `scheduler-delivery-failures`
  alarms. Full runbook (incl. manual `aws lambda invoke` drills) in
  `infra/README.md`.

### Distributed tracing (OpenTelemetry)

Tracing is **off by default** and adds nothing to the request path until
you switch it on. To watch it locally (no AWS needed):

```powershell
# In backend\shop-api\.env (or the shell), then restart npm run api:dev:
$env:ENABLE_TRACING="true"; $env:OTEL_TRACES_EXPORTER="console"
npm run api:dev
# Hit any endpoint:
curl -s localhost:3001/health | Out-Null
```

In `api:dev`'s stdout you'll now see, for that one request:

- the structured Pino lines (`request_start` / `request_end`) each
  carrying a **`trace_id`** and **`span_id`**, and
- the exported span itself (the `console` exporter prints it) — a
  `GET /health` span whose `traceId` matches those log lines, with
  `http.route`, `http.response.status_code`, and an **`app.request_id`**
  attribute equal to the `X-Request-Id` header on the response.

That three-way match — `X-Request-Id` ↔ trace ↔ logs — is the whole
point: from any log line you can pivot to the full trace and back.

- **Unit level:** `npm --workspace @shop/api run test` — the
  `tests/lib/tracing.test.ts` suite (5 blocks) proves the
  `ENABLE_TRACING` toggle, the no-op path when off, the Pino
  `trace_id`/`span_id` correlation, and that a `@hono/otel` request span
  is produced and correlated. Set `OTEL_TRACES_EXPORTER=otlp` to send to
  a real backend instead of the console.
- **Live stack:** set `enable_tracing = true` and
  `adot_collector_layer_arn = "<the ADOT collector layer for your
  region+arch>"` in `terraform.tfvars`, rebuild + redeploy `shop-api`
  (`npm --workspace @shop/api run build:lambda`), apply, then make a
  request through CloudFront — the trace (Lambda root segment + the Hono
  span + the Neon/HIBP `fetch` spans) appears in the **AWS X-Ray**
  console, and every CloudWatch log line for that request carries the
  same `trace_id`. Full runbook in `infra/README.md` → "Tracing runbook".

### SLOs + burn-rate alerting (OpenSLO)

The SLO objectives live in `infra/slos.yaml` (OpenSLO v1); the multi-window
multi-burn-rate alarms are in `infra/slo.tf`, behind `enable_slo_alarms`. The
SLIs are read from the structured `request_end` log line the API already
emits — now carrying `method`, `path`, `status`, `durationMs`. To see that
source line locally (the same JSON the CloudWatch metric filters parse):

```powershell
# request_end is INFO-level, so make sure the API logs at info:
$env:LOG_LEVEL="info"; npm run api:dev
# In another shell, hit a couple of endpoints:
curl -s localhost:3001/health | Out-Null
curl -s localhost:3001/products | Out-Null
```

In `api:dev`'s stdout each request now ends with a line like
`{"level":30,...,"method":"GET","path":"/health","status":200,"durationMs":3,"msg":"request_end"}`.
The five metric filters in `infra/slo.tf` turn that into the availability,
latency and order-success SLIs:

- **availability** — `{ $.msg = "request_end" && $.status >= 500 }` ÷ all
  `request_end`;
- **order success** — `{ … $.method = "POST" && $.path = "/orders" && $.status = 201 }`
  vs `… $.status >= 500`;
- **latency** — the `$.durationMs` value, alarmed at p95.

The alarms themselves are AWS-side. To exercise them on a live stack set
`enable_slo_alarms = true` **and** `log_level = "info"` in `terraform.tfvars`,
apply, then drive traffic (a load of 5xx responses trips the availability
fast-burn page within the hour; the short-window arm reacts in ~5 min). Full
runbook in `infra/README.md` → "SLO + burn-rate runbook".

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

**Database driver:** `createDb()` (`backend/db/src/client.ts`) picks the
Neon **serverless** driver in prod (any `*.neon.tech` URL) and node-pg
locally. The Neon driver sends ordinary queries over a stateless HTTPS
fetch (`poolQueryViaFetch` — no held connection, no Lambda connection
storm) and opens a WebSocket **only** for an interactive
`db.transaction(...)`. This replaced the original `neon-http` driver
(2026-06-13), which throws `No transactions support in neon-http driver`
— a prod-only failure the live catalog-backup drill exposed, and which
would equally have broken checkout, registration, password reset, email
change/verification, account deletion, and admin order transitions (all
use `db.transaction`). `channel_binding=require` is stripped for the
WebSocket path and the Node 22 global `WebSocket` is used (no `ws` dep).
Zero call-site changes. Full rationale in `docs/ARCHITECTURE.md` §13.

**CSP:** Uniform strict `'nonce-X' 'strict-dynamic'` on every HTML
document via the frontend proxy. The earlier hybrid (permissive on
catalog, strict on account) was found to be silently bypassed by SPA
soft navigation because the document's CSP is fixed at HTML document
load and reused across client-side route changes. Reasoning + rejected
design recorded in `docs/ARCHITECTURE.md` §5.2.

**Email transports:** `sqs` (production target since 2026-06-12 —
enqueues the rendered email onto the durable SQS queue; requires
`EMAIL_QUEUE_URL`), `ses` (inline `@aws-sdk/client-sesv2` send,
region-pinned to `eu-central-1` for GDPR), `console` (dev — prints
payload + a `VERIFY URL ⇒` line), `stub` (in-memory recorder for
tests). Selected by `EMAIL_TRANSPORT` env. Constructed lazily on
first send, then memoised — keeps Lambda cold-start budget tight.

**Email send posture:** best-effort, never blocking. A failed
verification / reset / withdrawal-acknowledgement email logs the
error and continues; the user can recover via resend. Under the `sqs`
transport "sent" means *durably enqueued*: the email-fn Lambda retries
the real SES send (partial-batch responses, `maxReceiveCount` 5) and
parks exhausted messages in a DLQ watched by a CloudWatch alarm, so a
transport failure can delay but no longer silently drop a
durable-medium email.

**Token cryptography (verification, reset, email-change):** 32-byte
CSPRNG → base64url, SHA-256-hashed in `*_tokens.token_hash`,
single-use (`consumed_at`), validity 24h for signup, 1h for reset
and email-change. Bad / expired / consumed all return the SAME
generic 400 — no enumeration of token state.

**Guest order-tracking token (capability URL):** 32-byte CSPRNG → base64url
(256-bit), stored in `orders.guest_track_token`. Unlike the credential tokens
above it is a *capability URL* (W3C TAG), not a login magic link, so it is
**durable** (no expiry — the spec needs last-week's email to still work) and
deliberately **NOT hashed at rest**: the PII it gates (customer email/name/
phone, delivery address) sits in plaintext in the same row, so hashing the
token would defend against nothing a DB-read attacker doesn't already have,
while costing the ability to re-embed the link in later status emails. Its job
is outside-unguessability — 256 CSPRNG bits over-satisfy OWASP's ≥128-bit bar
(the prior `crypto.randomUUID()` was 122). Leak mitigations: never logged,
`/track` served `noindex` + `no-referrer`, find-my-order rate-limited and
enumeration-resistant, unknown/malformed tokens → uniform `404`. Full rationale
in `docs/ARCHITECTURE.md` §13.

**Enumeration resistance by contract:**
`POST /auth/forgot-password`, `POST /auth/email-change/request`, and
the responses for unknown vs registered emails on `/auth/login` and
`/auth/register` all return identical bodies in every internal
outcome (happy path / unknown / rate-limited / send failure). The
only non-resistant 4xx branches are explicit user errors the user
can already see (wrong current password, new == current).

**Observability / tracing:** structured Pino JSON (PII-redacted,
per-request child logger on `X-Request-Id`) plus app-level
OpenTelemetry (roadmap item 18, 2026-06-13) behind `ENABLE_TRACING`
(default off, zero cost when off). `@hono/otel` request spans + undici/
`fetch` downstream spans; a Pino `mixin` stamps `trace_id`/`span_id` on
every line and `X-Request-Id` becomes the `app.request_id` span
attribute. Vendor-neutral OTLP export — prod routes through the ADOT
collector layer to X-Ray; the backend is one env var. `pg`/`aws-sdk`
auto-instrumentation is intentionally omitted (require-patching no-ops
under the esbuild bundle; `diagnostics_channel`-based undici does not).
Full rationale in `docs/ARCHITECTURE.md` §8.2 + §13.

## Known gaps

What's documented elsewhere but doesn't exist or has drifted from
reality, as of 2026-06-07:

- **`infra/` directory** — authored, statically validated, and now
  **proven by a successful live `terraform apply`** (2026-06-07): a
  deploy returned HTTP 200 end-to-end through CloudFront → OAC →
  Lambda. Two apply-time fixes were folded in: the Function URL CORS
  `allow_methods` (AWS rejects methods >6 chars, e.g. `OPTIONS`), and
  the post-Oct-2025 requirement that CloudFront OAC also hold
  `lambda:InvokeFunction` (not just `lambda:InvokeFunctionUrl`). What
  is NOT yet done: a *maintained* production environment — a custom
  domain, the schema migrated to Neon, and the frontend deployed (the
  test deploy can be torn down with `terraform destroy`).
- **`admin-api` Lambda** — referenced in `docs/ARCHITECTURE.md` §3.4;
  not created as a separate Lambda. The admin surface that exists
  (auth + the orders, categories, and products slices) lives in `shop-api`
  under `routes/admin/*`; the remaining `/admin/*` frontend pages (customers,
  banners, settings, archive) render mock data — as does the products page,
  though its backend `/admin/products/*` now exists (2026-06-22) and only
  needs frontend wiring.
- ~~**`scheduler-fn` Lambda**~~ ✅ Shipped 2026-06-12 (roadmap item
  23): the three cron rules run as idempotent sweeps in `@shop/api`
  `src/jobs/*` behind EventBridge Scheduler (`infra/scheduler.tf`,
  flag `enable_scheduler`) — hourly pickup-expiry admin notice
  (claim-marked, exactly-once), 03:00 Sofia catalog backup to a
  versioned 90-day S3 bucket (indexed in `catalog_backups`), 04:00
  Sofia unverified-account cleanup (day-6 warning / day-7 hard
  delete) + the 180-day `login_attempts` retention prune. Migration
  `0004_scheduler_jobs`; 18 integration tests; two new templates;
  runbook in `infra/README.md`. **Live-validated 2026-06-13** — all
  three job drills passed against a Neon branch; that drill also caught
  and fixed a prod-only bug (the `neon-http` driver can't run
  `db.transaction(...)` → switched to the Neon serverless WebSocket
  driver, see the Database-driver decision above).
- ~~**Order status update wire-up**~~ ✅ Shipped 2026-06-10 with the
  admin orders slice — `POST /admin/orders/:orderNumber/status` calls
  `sendOrderStatusUpdateEmail` after each customer-visible transition
  commits.
- **Customer MFA (TOTP / WebAuthn)** — schema exists
  (`mfaRecoveryCodes` table), no flow. Roadmap item, growth-stage.
- **Admin auth (TOTP)** — **shipped end-to-end (2026-06-08)**, backend
  and frontend. `/admin/auth/*` on `shop-api` does mandatory TOTP MFA
  (login → challenge → TOTP/recovery → session), enrolment, and recovery
  codes, with full integration tests and the `@shop/api admin:create`
  bootstrap script. The frontend `/admin` section now renders an inline
  `AdminAuthGate` (login → MFA → first-login TOTP enrolment with manual
  secret entry → recovery codes) wired to those endpoints; the gating
  lives in `frontend/src/app/admin/layout.tsx`. What remains is purely
  structural: extracting the module onto a dedicated `admin-api` Lambda +
  subdomain once the admin CRUD surface grows. Roadmap item 35 is done.
- **Banner slides API** — the home-page carousel still imports from
  `frontend/src/lib/mock-data/banners.ts`. A real `banner_slides`
  endpoint + admin CRUD is its own slice — now **unblocked** by the
  image-upload pipeline (2026-06-22, item 46): banner images can use
  the same `/admin/uploads` presign + `assets-fn` validator as products
  and categories (`kind: "banners"`), so the banners slice no longer
  waits on an upload path.
- **Courier-office picker** — the checkout step renders Bulgarian
  Econt/Speedy offices from `mock-data/courier-offices.ts`. Real
  ingestion (either a one-off seed from the carrier APIs or a
  cron-refreshed table) is a future slice.
- ~~**Distributed tracing**~~ ✅ Shipped 2026-06-13 (roadmap item 18):
  OpenTelemetry on `shop-api` behind `ENABLE_TRACING` — `@hono/otel`
  request spans + undici/fetch downstream spans + Pino `trace_id`/`span_id`
  log↔trace correlation, exporting OTLP to AWS X-Ray via the ADOT collector
  layer (`enable_tracing` + `adot_collector_layer_arn`). Closed the last
  concrete OWASP A09 / NIST CSF Detect gap. Runbook in `infra/README.md`.
- ~~**SQS retry queue for SES**~~ ✅ Shipped 2026-06-12 (roadmap item
  21): `sqs` transport + queue envelope + email-fn consumer in
  `@shop/email`, `EMAIL_TRANSPORT=sqs` wiring in `shop-api`, and the
  Terraform (`infra/sqs.tf` + `infra/email-fn.tf`, behind
  `enable_email_queue`) with DLQ + two alarms. Closes the EU 2023/2673
  Art. 11a(2) durable-medium + Art. 8(7) confirmation-of-contract
  audit margins on email-send failure. Enabled + **live-validated on
  the running test stack the same day**: real delivery through
  queue → email-fn → SES, plus the failure drill (DLQ park → alarm →
  redrive). Runbook in `infra/README.md`.
- **DR drill** — procedure documented, never executed (roadmap item 19).
- ~~**Formal SLOs in YAML + burn-rate alarms**~~ ✅ Shipped 2026-06-14
  (roadmap items 24/25): `infra/slos.yaml` (OpenSLO v1 — availability,
  order-success, p95 latency) + `infra/slo.tf` multi-window multi-burn-rate
  composite alarms over CloudWatch Logs metric filters on the `request_end`
  line, behind `enable_slo_alarms` (requires `log_level = "info"`). Defined +
  apply-ready; awaits live traffic to exercise the budgets.
- **Status page, DORA metrics** — remaining roadmap items in §15.

## Recommended next steps

In priority order (also tracked in `docs/ARCHITECTURE.md` §15):

1. **First production deploy.** The `infra/` Terraform that provisions
   it (`shop-api` Lambda, Function URL, CloudFront/OAC, ACM, SSM, KMS,
   CloudWatch log group, 8 alarms (2 gated on the email queue, 2 on
   the scheduler), GitHub OIDC deploy role; opt-in
   WAF/Route 53/SES/Amplify/email-queue/scheduler) has now **run end-to-end**: a live
   `terraform apply` (2026-06-07) returned HTTP 200 through
   CloudFront → OAC → Lambda, so the architecture is no longer
   hypothesis. What remains for a *maintained* production environment:
   a custom domain, migrating the schema to Neon, and deploying the
   frontend. Follow `infra/README.md`.
2. ~~**ADOT distributed tracing.**~~ ✅ Shipped 2026-06-13 (item 18) —
   closed the OWASP A09 + NIST CSF Detect gap. SLOs-as-code + multi-window
   burn-rate alarms (items 24/25) followed 2026-06-14. The first real DR
   drill (item 19) is now the next infra step.
3. **First real DR drill** against a Neon PITR branch. Write up the
   timestamped result. 2 hours including doc.
4. ~~**Address book CRUD.**~~ ✅ Shipped 2026-06-01. `/addresses` CRUD
   (list / create / PATCH / soft-delete) + `/account/addresses` UI,
   linked from the profile. Activated the previously-dead `addresses`
   table that the GDPR export and account-deletion already referenced.
   28 integration tests.
5. ~~**SQS retry queue for SES.**~~ ✅ Shipped AND live-validated
   2026-06-12 (see the Known-gaps entry). The compliance row moved
   from "wired but best-effort" to "wired with a durable retry queue,
   proven on the running stack" — the maintained deploy (item 1)
   carries the same flags (`enable_email_queue` + `email_transport =
   "sqs"`).
6. ~~**Real storefront browsing.**~~ ✅ Shipped 2026-05-28. Home page,
   `/search`, `/products/[...path]`, and the header autocomplete all
   render from the live `@shop/api` catalog. Banner slides remain on
   mock data (no banners endpoint); admin pages remain on mock data
   (no admin-api).
7. ~~**First admin slice (orders).**~~ ✅ Shipped 2026-06-10 —
   `/admin/orders/*` on `shop-api` behind `requireAdmin` (list +
   filters + search + CSV export, detail + audit timeline,
   state-machine status transitions with optimistic locking and the
   customer status-update emails) plus the real `/admin/orders` UI.
   The manual `status='accepted'` psql is retired. Since then the
   **categories** slice shipped (2026-06-15, backend + frontend) and the
   **products** backend shipped (2026-06-22; `/admin/products` frontend
   pending). What remains: the dedicated `admin-api` Lambda extraction and
   the customers / banners / settings / archive slices.

Items currently described in the architecture but not yet real
(the remaining admin CRUD slices, the `admin-api` Lambda split, a
maintained production deploy — `scheduler-fn` came off this list
2026-06-12) should be brought into reality before any further
"growth-stage" items (customer MFA, multi-region, SLSA L3,
Cloudflare proxy swap).

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
