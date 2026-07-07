# Architecture — Best Online Shop Ever

> The single technical doc that explains how the system is built today,
> what its intended production posture looks like, the decisions
> behind each choice, the gaps between in-repo and intended-production
> state, and the roadmap to close them.
>
> Companion doc: `COMPLIANCE.md` — the standards-by-standards matrix
> (NIST CSF 2.0, OWASP Top 10 2025, OWASP ASVS 6.0, NIST SP 800-63B-4,
> SLSA, CIS Controls v8.1, GDPR, EU CRA, WCAG 2.2). This doc is the
> narrative; that one is the auditor-facing table.
>
> Companion doc: `README.md` (Bulgarian) — the functional / product
> specification. Read that to learn *what* the shop does; this doc
> covers *how* it's built.
>
> Last updated: 2026-07-07. Reality-aligned: the `infra/` IaC is
> live-apply-validated (a test deploy returned 200 end-to-end); the
> **admin authentication backend** (mandatory TOTP MFA, `/admin/auth/*`)
> shipped 2026-06-08; the **durable email queue** (item 21) and
> **scheduler-fn** (item 23) shipped + live-validated 2026-06-12/13;
> **distributed tracing** (OpenTelemetry, item 18) shipped 2026-06-13 —
> closing the last OWASP A09 / NIST CSF Detect gap (§8.2); **SLOs as
> code + multi-window burn-rate alerting** (items 24/25) shipped 2026-06-14
> (`infra/slos.yaml` + `infra/slo.tf`, §7.2/§8.5); the **incident-response
> playbook** (item 31) shipped 2026-06-15 (`docs/INCIDENT-RESPONSE.md`),
> closing the NIST CSF Respond + GDPR Art. 33/34 gaps (§5.4, §11, §14); the
> **image-upload pipeline** (item 46) shipped + live-validated 2026-06-27; and
> the admin **frontend** is now substantially real — orders, categories,
> products, **banners** (item 47, 2026-06-29), **store settings** (item 48,
> 2026-06-30, config-off-env), **account management** (item 49, 2026-07-03 —
> per-account B2B discounts + spec §10 account deletion), the read-only
> **dashboard** (item 50, 2026-07-06 — real operational metrics + a 14-day trend),
> and **archive & restore** (item 51, 2026-07-07 — soft-deleted restore lists, the
> spec §12 one-button manual backup, and the new category-restore route) are wired
> end-to-end. **The admin panel is now fully real** (archive was the last mock
> page). No maintained production environment is kept running yet; destructive
> restore-from-snapshot is the one archive capability deferred (item 52).

---

## Contents

1. [What this product is](#1-what-this-product-is)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [Layer by layer](#3-layer-by-layer)
4. [The life of a request](#4-the-life-of-a-request)
5. [Security model](#5-security-model)
6. [Reliability model](#6-reliability-model)
7. [Performance model](#7-performance-model)
8. [Observability model](#8-observability-model)
9. [Supply-chain security](#9-supply-chain-security)
10. [Cost model](#10-cost-model)
11. [Day-to-day operations](#11-day-to-day-operations)
12. [Disaster recovery](#12-disaster-recovery)
13. [Architecture decisions locked in](#13-architecture-decisions-locked-in)
14. [Honest assessment vs A+ target](#14-honest-assessment-vs-a-target)
15. [Roadmap to A+](#15-roadmap-to-a)
16. [Forward-looking design considerations](#16-forward-looking-design-considerations)
17. [Glossary](#17-glossary)

---

## 1. What this product is

A Bulgarian-language B2C and B2B e-commerce shop. Intended hosting:
AWS Frankfurt (`eu-central-1`) for GDPR data residency. Sells physical
goods only. Payment is **cash on delivery** or **pay at the physical
store** — no card numbers are ever received, stored, or transmitted.
That one fact removes PCI-DSS from scope and makes "production-grade"
reachable without a payment-processor audit.

Three actors are present in the codebase:

- **Guests** — browse and order without registering; cart stored
  per browser tab via `sessionStorage`.
- **Customers** — registered users, individuals (`accountType =
  personal`) or corporate (`accountType = corporate` with VAT/EIK
  fields).
- **Administrator** — exactly one role per the spec, on a separate
  subdomain (target). **The admin authentication backend is now built**
  (2026-06-08): `/admin/auth/*` on `shop-api` does mandatory TOTP MFA
  (AAL2), enrolment, and recovery codes — see §3.4. The admin **sign-in
  frontend** also shipped 2026-06-08: `/admin` renders an inline
  `AdminAuthGate` (login → MFA → enrolment) wired to those endpoints. The
  first real admin CRUD slice — **order management** (`/admin/orders` list +
  detail + state-machine status transitions + CSV export) — shipped
  2026-06-10, backend and frontend, followed by **category management**
  (2026-06-15, backend + frontend) and **product management** end-to-end
  (`/admin/products/*` backend 2026-06-22; the `/admin/products` list + create/
  edit frontend and the image-upload widget wired 2026-06-27), **banner
  management** (2026-06-29, backend + frontend), **store settings**
  (2026-06-30, backend + frontend — moving operator config off env onto the
  runtime-editable `settings` table), **account management** (2026-07-03,
  backend + frontend — per-account B2B discounts + account deletion, activating
  the write side of the `discounts` table), and the read-only **dashboard**
  (2026-07-06 — real operational metrics + a 14-day realised-sales trend, un-mocking
  the `/admin` landing page), and **archive & restore** (2026-07-07 — soft-deleted
  restore lists, the spec §12 one-button manual backup, and the new category-restore
  route). **Every admin page is now real.** Still pending: the dedicated
  **`admin-api`** Lambda the admin panel will eventually live on, and the destructive
  restore-from-snapshot (item 52).

Functional scope is in `docs/README.md`. Deployment status is in
`README.md` ("Deployment status" section).

---

## 2. Architecture at a glance

The diagram below is the **target** posture. Every box marked **[T]**
exists in the repo and can run locally; every box marked **[P]** is
planned but not yet provisioned. As of 2026-06-07 the **[T]** components
run locally and the **[P]** AWS plumbing is now defined as
live-apply-validated Terraform in `infra/` (a test `terraform apply`
returned HTTP 200 end-to-end), though no environment is durably
maintained yet.

```
                              Internet
                                  │
                      ┌───────────▼────────────┐
                      │   DNS                  │  [P] Route 53 (planned)
                      │   (or Cloudflare)      │
                      └───────────┬────────────┘
                                  │
                      ┌───────────▼────────────┐
                      │   Edge protection      │  [P] AWS WAF + Shield
                      │                        │      Cloudflare (alt.)
                      └───────────┬────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
         shop.domain.bg                       admin.domain.bg
              │                                       │
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │  AWS Amplify         │  [P]           │  AWS Amplify         │  [P]
   │  Next.js 16          │  [T] (code)    │  (admin)             │  [P]
   └──────────┬───────────┘                └──────────┬───────────┘
              │                                       │
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │  Lambda shop-api     │  [P] (deploy)  │  Lambda admin-api    │  [P]
   │  Hono + Drizzle      │  [T] (code)    │  Not yet written     │  [P]
   └──────────┬───────────┘                └──────────────────────┘
              │
              ▼
   ┌──────────────────┐
   │  PostgreSQL      │  [T] Docker Postgres 17 locally
   │  (Neon planned)  │  [P] Neon in production
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │  Amazon S3       │  [P] images + backups
   └──────────────────┘

   [T] EventBridge Scheduler ──► [T] Lambda scheduler-fn (3 Sofia-time crons + delivery DLQ)
                           (code + IaC, 2026-06-12; flag enable_scheduler)
   [T] Lambda scheduler-fn ──► [T] S3 catalog-backup bucket (daily, 90-day lifecycle)
   [T] Lambda shop-api ──► [T] SQS email queue (+DLQ) ──► [T] Lambda email-fn ──► SES
                           (code + IaC, 2026-06-12; flag enable_email_queue)
   [T] Lambda * ──► [T] Amazon SES (code), 14 transactional templates
   [P] Lambda * ──► [P] CloudWatch Logs / Metrics / 8 Alarms
   [P] Lambda * ──► [P] SSM Parameter Store (runtime secrets)
   [P] ACM ──► [P] CloudFront + Amplify (auto-renew TLS)
```

The shortest target description: **Next.js frontend on Amplify; Hono
backend on Lambda; Neon Postgres; AWS WAF + CloudFront + S3 + SES +
EventBridge + CloudWatch + Parameter Store gluing it together.** The
shortest honest description of today's state: **the codebase is
ready for that deployment; the deployment hasn't happened.**

---

## 3. Layer by layer

Each subsection states what exists in the repo today and what the
target production posture looks like. Sections marked "Target" are
design, not running infrastructure.

### 3.1 DNS

**Target:** Route 53 hosted zone (~$0.50/mo) or Cloudflare Free DNS.
A planned cost-and-security swap to Cloudflare is documented in §10.

**Today:** No production DNS. The shop is reachable only on
`localhost:3000`.

### 3.2 Edge protection

**Target:** AWS WAF + AWS Shield Standard. WAF would run:

- `AWSManagedRulesCommonRuleSet` (OWASP baseline)
- `AWSManagedRulesSQLiRuleSet`
- Custom rate-limit rules on `/auth/login`,
  `/auth/resend-verification`, `/track/:token`
- Stricter rules attached to `admin.domain.bg`

**Cloudflare alternative:** Cloudflare Free's L3/L4/L7 DDoS coverage
is materially stronger than AWS Shield Standard for this scale; this
is the documented preferred path for production (see §10).

**Today:** No edge protection. Local dev runs against `localhost`
without WAF.

### 3.3 Frontend — Next.js 16

**Today (code, runs locally):**

- React 19 + Next.js 16 application under `frontend/`.
- Server Components for initial paint, including `getServerUser()`
  which reads the session cookie via `next/headers` and embeds the
  user into the SSR response (no auth flicker).
- Thin proxy at `frontend/src/proxy.ts` does cookie-presence checks
  and emits the strict CSP headers + Reporting-Endpoints on every
  HTML response.
- Pages around auth (`/account/login`, `/account/register`,
  `/account/profile`, `/account/email-change`,
  `/account/reset-password`, `/account/delete`), cart, and orders are
  all real and wired to `@shop/api`. Storefront browsing
  (`/products/[...path]`, `/search`, home product rails) moved to the
  live catalog API 2026-05-28; the **home banner carousel** moved to the
  live `/banners` API 2026-06-29. The admin sign-in (2026-06-08), the
  admin **orders** pages (list + detail + status transitions,
  2026-06-10), the admin **categories** page (2026-06-15), the admin
  **products** pages (list + create/edit + image upload, 2026-06-27), the
  admin **banners** page (2026-06-29), the admin **store settings** page
  (2026-06-30), the admin **account management** page (customers +
  per-account discounts + deletion, 2026-07-03), and the read-only admin
  **dashboard** (real operational metrics + a 14-day trend, 2026-07-06) are real.
- Pages still on mock data: only the checkout courier-office picker
  (Bulgarian Econt/Speedy office lists, not yet ingested into the DB).
  Every `/admin/*` screen is now backed by the API — archive, the last
  mock admin page, went real 2026-07-07 (item 51).

**Target (deployment):** AWS Amplify Hosting, two apps (shop + admin)
on two CloudFront distributions.

**Known constraint:** Amplify does NOT support on-demand revalidation
(`revalidateTag` / `revalidatePath`); only time-based ISR works. If
on-demand revalidation becomes critical, Vercel or a self-hosted
Node server behind CloudFront becomes the deployment target.

**On PPR / ISR:** Next.js 16's Partial Prerendering is production-
stable, but **this codebase does not use it today**. Every route
reads cookies on the SSR pass via `getServerUser()`, which forces
dynamic rendering. The earlier ARCHITECTURE.md claim of "ISR for
catalog pages" was technically incorrect; that has been corrected in
§5.2. PPR / ISR can be re-enabled later by moving auth hydration to
a client `useEffect` (at the cost of a small auth flicker).

The frontend talks to the backend via **Hono RPC** — a typed-fetch
client generated from the Hono `AppType`. End-to-end TypeScript types
without a separate codegen step.

### 3.4 Backend — Hono on AWS Lambda

**Today (code):** **one** Hono application in `backend/shop-api/`,
runnable locally via `@hono/node-server`. Routes mounted in
`backend/shop-api/src/app.ts`:

- `/products`, `/categories`, `/auth/*`, `/cart/*`, `/orders/*`,
  `/addresses/*`, `/consent`, `/csp-report`, `/health`, `/openapi.json`.

**Target (three Lambdas):**

- **`shop-api`** — customer-facing. The Hono app already in the repo.
- **`admin-api`** — admin panel backend. Order / product / category /
  customer / discount CRUD, banner management, content versioning,
  backup orchestration. **Not yet split out.** Admin *authentication*
  (`/admin/auth/*`, mandatory TOTP MFA — see below) and the CRUD slices
  shipped so far — **order management** (2026-06-10), **category management**
  (2026-06-15), **product management** (backend, 2026-06-22), the
  **image-upload pipeline** (`/admin/uploads/*`, 2026-06-22), and **banner
  management** (`/admin/banners/*`, 2026-06-29) at
  `/admin/orders/*`, `/admin/categories/*`, `/admin/products/*`,
  `/admin/uploads/*`, `/admin/banners/*` — live in
  `shop-api` today as self-contained, portable Hono modules (`routes/admin/*`)
  that will move here when the admin CRUD surface justifies a separate
  Lambda + subdomain. (The `assets-fn` validator Lambda is its own deployable,
  like `scheduler-fn`/`email-fn`.)
- **`scheduler-fn`** — three cron rules: daily catalog backup, hourly
  expired-pickup check, daily unverified-account cleanup (+ the
  login_attempts retention prune). **Shipped 2026-06-12** (roadmap
  item 23): the jobs live in `@shop/api` `src/jobs/*` (they are the
  stateful halves — DB sweeps + email sends), bundled into their OWN
  pure-JS Lambda artifact by `build-scheduler.mjs` (no argon2 in the
  import graph, builds on any OS), driven by EventBridge Scheduler
  (`infra/scheduler.tf`, flag `enable_scheduler`).

All three would be **Hono** (portable across Lambda, Workers, Bun,
Deno, Node). **Drizzle** is the ORM. **`@hono/zod-openapi`**
auto-generates the OpenAPI 3.1 contract from the typed routes.

Authentication primitives live in `@shop/auth`:

- **Argon2id** with `m=19456, t=2, p=1` (the OWASP-recommended low-
  memory profile, RFC 9106 compliant).
- 32-byte CSPRNG session tokens, SHA-256-hashed at rest in
  `sessions.id_hash`.
- Constant-time login (`argon2.verify` against `DUMMY_PASSWORD_HASH`
  for unknown emails).
- **NIST SP 800-63B Rev. 4** password policy (shipped May 2026):
  ≥12 chars, ≤1024 chars, no composition rules, screened against
  the Have I Been Pwned breach corpus at registration, password
  reset, AND authenticated password change via the k-anonymity
  API. HIBP failure-mode is open (a warning log, not a hard block).
  Login is NOT gated by the HIBP check, so existing customers
  cannot be locked out retroactively.
- **Authenticated password change** (shipped May 22, 2026): `POST
  /auth/change-password`. Requires the current password as re-auth
  proof. Closes OWASP ASVS V6.2 / NIST SP 800-63B-4 §5.1.1.2. On
  success the hash rotates, every OTHER session for the user is
  dropped (the initiating session is preserved), and a best-effort
  notification email fires.
- **Admin authentication — mandatory TOTP MFA** (shipped 2026-06-08):
  `/admin/auth/*` on `shop-api`. **AAL2** (NIST SP 800-63B-4) — password
  *and* an RFC 6238 time-based OTP. Two-step so no session is minted
  before both factors pass: `POST /login` verifies the password and
  returns a short-lived HMAC-signed challenge (`mfa_required` or
  `enrollment_required`); `POST /mfa` verifies the TOTP code (or a
  single-use recovery code) against that challenge and only then opens
  the session; `POST /mfa/setup` + `/mfa/setup/confirm` handle
  first-login enrolment and emit 10 single-use recovery codes once. The
  crypto primitives (TOTP, recovery codes, AES-256-GCM secret-at-rest,
  challenge HMAC) live in `@shop/auth`; the DB plumbing in
  `@shop/api`'s `lib/admin-mfa.ts`. Hardening beyond customer auth:
  30-min / 5-fail lockout (vs 15-min), 30-min session idle (vs 2 h), the
  TOTP secret AES-256-GCM-encrypted at rest with a key held only in SSM
  (the DB never sees it), a replay guard (`users.mfa_last_used_step`)
  making every code single-use even inside its skew window, and a
  uniform `404` on the admin surface for non-admins (no enumeration of
  its existence). This was the documented prerequisite (§15 item 35) for
  the admin CRUD surface (item 22), whose first slice — order management
  at `/admin/orders/*` — shipped behind `requireAdmin` on 2026-06-10.

Errors follow **RFC 9457 Problem Details**. Logs use **Pino with
PII redaction**, structured JSON, per-request child logger keyed on
`X-Request-Id`.

### 3.5 Database — Neon PostgreSQL (target) / Docker Postgres (today)

**Today:** A local Docker Postgres 17 instance brought up via
`npm run db:up`. The Drizzle schema in `backend/db/src/schema/` is
applied via `npm run db:migrate` and a deterministic seed at
`npm run db:seed`. Migrations: `0000_initial.sql`,
`0001_orders_sequence.sql`, `0002_complaints_withdrawal.sql`,
`0003_admin_mfa_replay_guard.sql`, `0004_scheduler_jobs.sql`,
`0005_rate_limit_counters.sql`. The running test stack also has the
earlier five applied to a Neon branch (2026-06-13) — the scheduler-fn
drills ran against it.

**Schema scope:** 31 tables, 32 FKs, 47 indexes, 10 enums, 6 migrations
(`0000`–`0005`). No migration since `0005_rate_limit_counters` — the recent
admin slices (settings, customers, dashboard, archive) all activate
already-modelled tables.

**Target:** Neon Postgres. `createDb()` picks the Neon serverless
driver in prod and the node-pg driver in dev. The serverless driver
sends ordinary queries over a stateless HTTPS fetch (no held
connection) and opens a WebSocket only for the duration of an
interactive `db.transaction(...)` — the HTTP-only driver could not
run transactions at all. **Neon Scale** is the
contractually-acceptable production tier; **Neon Launch (~€18/mo)**
is the practical entry tier; **Neon Free** is an SPOF and acceptable
only for dev branches (it auto-suspends after ~5 minutes idle).

Design choices that are load-bearing:

- **Money as integer cents** via `numeric(10,0)` — never floats.
- **All timestamps `timestamptz`.**
- **UUIDs via `gen_random_uuid()`** — server-generated.
- **Soft delete via `deleted_at`** on `users` and adjacent tables.
- **Optimistic locking** via `version` on orders.
- **`idempotency_key` UNIQUE** on orders — retries return the
  original order verbatim.
- **Order line items snapshotted** at checkout — product name, code,
  image, unit price frozen onto each line so future catalog edits
  cannot rewrite history.

Connection handling: the Neon serverless driver holds no persistent
connection for ordinary queries (each is one HTTPS fetch), so the
classic Lambda-vs-Postgres connection storm does not arise. Only an
interactive `db.transaction(...)` opens a WebSocket, scoped to that
transaction and capped at one per warm container. The runtime points
at Neon's pooled (`-pooler`, PgBouncer transaction-mode) endpoint,
which is compatible with these short transactions; the node-pg dev
driver still uses a real 3-connection pool.

### 3.6 Object storage — Amazon S3

**Today:** Two S3 roles are live; a third (image transcoding) is a
documented door.

1. **Daily catalog backups** — shipped 2026-06-12 (item 23). A
   date-keyed JSON snapshot of the four catalog tables to a versioned,
   90-day-lifecycle, SSE-KMS bucket, written by the scheduler-fn
   catalog-backup job (`infra/scheduler.tf`). Zero personal data.
2. **The image-upload pipeline** — shipped 2026-06-22 (item 46,
   `infra/assets.tf`, flag `enable_asset_uploads`). The keystone the
   catalog had been waiting on: products / categories / banners stored
   S3 keys (`images.ts` derives the URL) but no entity could put bytes
   behind a key. Now a **private assets bucket** carries two prefixes —
   `pending/` (un-validated upload target) and `uploads/` (served) — a
   **CloudFront + OAC** distribution serves ONLY `uploads/` (via
   `origin_path`, so `pending/` is unreachable through the CDN), and the
   **assets-fn** validator Lambda magic-byte-checks every upload and
   promotes only genuine images. The browser uploads straight to S3 with
   a short-lived **presigned POST** minted by shop-api
   (`routes/admin/uploads.ts`) — never through Lambda (a 6 MB sync
   payload cap and a pay-per-byte cost both sidestepped). The POST policy
   pins the exact key, a `content-length-range`, and the `Content-Type`;
   the validator re-derives the TRUE type from the bytes because a
   declared MIME is not proof of content. Built once, it serves all three
   image-bearing entities uniformly (the `kind` field selects the key
   folder). Design rationale in §13.

**Future enhancement (a §16 door, not yet built):** **Sharp.js
transcoding at upload time** — re-encode each promoted image into
pre-optimised WebP/AVIF variants (e.g. 1200×1200 / 400×400 / 150×150)
and strip EXIF metadata. The assets-fn validator is the natural home
for it, but it adds a native (`sharp`) Lambda dependency and an
arch-matched binary, so it is deferred until a real performance or
metadata-privacy need (uploads are admin-only today — the shop owner's
own product photos — so the third-party-PII-in-EXIF risk is low). The
key layout already accommodates variants (a `<kind>/<uuid>/` folder per
image) without a data migration.

**Possible migration to Cloudflare R2** for free egress and to
eliminate one AWS lock-in point — `CDN_BASE_URL` already abstracts the
serving origin, so this is a config change, not a code change. See §10.

### 3.7 Email — Amazon SES

**Today (code):** `@shop/email` exposes an `EmailTransport`
interface with four implementations (`ses`, `sqs`, `console`,
`stub`), selected via `EMAIL_TRANSPORT`. **Fourteen** Bulgarian
templates are rendered server-side:

1.  Registration verification (`verification`)
2.  Password reset (`password-reset`)
3.  Post-reset / post-change security notice (`password-changed`)
4.  Email-change verify, sent to NEW address (`email-change-verify`)
5.  Email-change alert, sent to OLD address at request time
    (`email-change-alert`)
6.  Email-changed notice, sent to OLD address after rotation
    (`email-changed`)
7.  Withdrawal acknowledgement to customer (`withdrawal-received`)
8.  Withdrawal admin notification (`withdrawal-admin-notification`)
9.  Account-deletion notification (`account-deleted`)
10. Order confirmation (`order-confirmation`) — durable-medium
    confirmation of contract conclusion, fires from `POST /orders`
    the moment the checkout transaction commits. Includes the order
    snapshot, line items with frozen prices, money totals, delivery
    or pickup info, and a 14-day right-of-withdrawal pointer
    referencing чл. 50 ЗЗП + EU Directive 2023/2673.
11. Order status update (`order-status-update`) — status-aware copy
    for each customer-visible transition (`accepted`,
    `ready_for_pickup`, `shipped`, `delivered`, `cancelled`). Wired
    since 2026-06-10: `POST /admin/orders/:n/status` fires it
    best-effort after every customer-visible transition commits
    (`returned` is internal bookkeeping and sends nothing).
12. Data-export security notice (`data-exported`) — out-of-band
    "your data was exported" notice, fires from `POST /auth/me/export`
    the moment the GDPR Art. 15/20 export is generated. Carries no
    payload and no link (the data went over the authenticated channel);
    directs a surprised recipient to secure their account, mirroring
    the `password-changed` pattern.
13. Expired-pickup admin notification (`pickup-expired-admin`) —
    operations notice to the support inbox, sent once per order by
    scheduler-fn's hourly sweep when a `ready_for_pickup` deadline
    passes (2026-06-12). Order number + customer contact + admin deep
    link; the decision stays manual per spec §7.
14. Unverified-account deletion warning (`account-deletion-warning`)
    — the day-6 „ще бъде изтрит утре" notice from scheduler-fn's
    daily cleanup (2026-06-12), with a FRESH 24h verification link as
    the primary CTA and an explicit "no action needed if this wasn't
    you" default.

**Critical: email sending is best-effort, never blocking.** A failed
verification email at registration creates the account anyway and
tells the user to use "resend verification." Same for password
reset, email change, the 14-day withdrawal receipt, and the
order-confirmation — the order is already durable in the DB at the
moment the email send fires; a transport failure logs a structured
`order_confirmation_email_failed` warn event and lets the request
return 201.

**Durable delivery (shipped 2026-06-12 — roadmap item 21).** In
production the transport is `sqs`, not `ses`: shop-api enqueues the
RENDERED email (a versioned envelope, `@shop/email src/queue/`) onto
an SQS standard queue, and the **email-fn** Lambda — a second, tiny
deployable bundled from `@shop/email` (`npm run build:lambda` →
`src/queue/handler.ts`) — consumes it and performs the real SES send.
Mechanics, per 2026 AWS prescriptive guidance:

- The event source mapping enables **partial-batch responses**
  (`ReportBatchItemFailures`): one bad record redelivers alone; its
  batch-mates are sent exactly once.
- Failures (transient throttles, permanent rejections, malformed
  envelopes) all take one path: redelivery with visibility-timeout
  spacing (180 s = 6 × the 30 s function timeout), then after
  `maxReceiveCount` (5) the message parks in the **DLQ** — the audit
  trail of undelivered durable-medium email. Two CloudWatch alarms
  watch the pair: DLQ depth > 0 and queue age > 15 min.
- Standard queue, **not FIFO** — ordering between independent emails
  is meaningless; the cost is at-least-once delivery (a rare duplicate
  email is harmless, a lost one is a compliance gap). SES itself
  carries the same duplicate caveat on retried sends.
- The queue carries personal data (rendered bodies), so it is
  SSE-KMS-encrypted with the project CMK; messages are deleted on
  successful send. email-fn holds **no DATABASE_URL and no SSM
  access** — least privilege per deployable.

This closes the two audit margins formally — **withdrawal receipt**
(EU 2023/2673 Art. 11a(2) durable medium; the on-screen
acknowledgement remains the primary medium per recital 37) and
**order confirmation** (Art. 8(7) "within a reasonable time"; the
`/account/orders/{n}` page remains the first-party read path). An SES
outage is now a backlog-drain concern, not a compliance concern.
Enabled + **live-validated on the running test stack 2026-06-12**: a
real email delivered through queue → email-fn → SES, and the failure
drill parked a message in the DLQ, fired the alarm, and redrove it
after the fix (runbook: infra/README.md). The maintained deploy
(item 17) carries the same flags.

**Production SES prerequisites** (must be completed before flipping
`EMAIL_TRANSPORT=ses` in production, per the Google/Yahoo/Microsoft
2026 bulk-sender rules):

- DKIM verified (3 CNAMEs in the SES console).
- Custom MAIL FROM subdomain so SPF aligns with the visible `From:`.
- DMARC record at `_dmarc.shop.example.com` (start `p=none`, tighten
  to `p=quarantine` once clean).
- Move the SES account out of sandbox via Service Quotas.

### 3.8 Background jobs — Amazon EventBridge Scheduler

**Today (shipped 2026-06-12, roadmap item 23):** three cron rules in a
schedule group, all `Europe/Sofia` wall-clock (EventBridge Scheduler
handles EET↔EEST, so 03:00 stays 03:00 year-round), invoking the
`scheduler-fn` Lambda with a static `{"job":"…"}` input. Behind
`enable_scheduler` (default off), `infra/scheduler.tf`:

- `cron(0 * * * ? *)` — **pickup-expiry**: claims expired
  `ready_for_pickup` orders (`pickup_expired_notified_at` set in the
  same UPDATE that selects — exactly-once claim under at-least-once
  scheduling) and emails the admin per spec §7. The order is NOT
  transitioned — the admin decides manually. A refused send is
  compensated (claim surrendered) so the next hour retries.
- `cron(0 3 * * ? *)` Sofia — **catalog-backup**: full JSON export of
  the four catalog tables (soft-deleted rows included) to the
  versioned, SSE-KMS, TLS-only backup bucket at
  `catalog/<YYYY-MM-DD>.json` (Sofia calendar date → same-day re-runs
  overwrite idempotently). Deterministic row order keeps unchanged
  re-runs byte-identical. Zero personal data by design — the GDPR
  backup-erasure tension cannot apply to it. 90-day lifecycle expiry.
- `cron(0 4 * * ? *)` Sofia — **unverified-cleanup**: day-6 warning
  email (claim marker `unverified_deletion_warning_at`, fresh 24h
  verification token in the CTA), day-7 hard DELETE of unverified
  customers (no pseudonymised remnant — nothing is legally retained;
  guarded by `role='customer'`, a `NOT EXISTS(orders)` rail, and a
  partial index that structurally excludes the bootstrap admin), plus
  the 180-day `login_attempts` retention prune (Art. 5(1)(e)).

Failure model — two disjoint lanes, two alarms (§3.10): the Scheduler
invokes Lambda ASYNCHRONOUSLY, so in-function job failures surface on
the Lambda `Errors` metric (after Lambda's 2 async retries) → the
scheduler-fn-errors alarm; DELIVERY failures retry per the schedule's
`retry_policy` (3 attempts / 30 min) then park in the scheduler DLQ →
the scheduler-delivery-failures alarm. There is deliberately NO
job-level redrive: every job is an idempotent full-scan sweep, so the
next cron tick IS the redrive.

Ops: same jobs run locally via
`npm --workspace @shop/api run job -- <name> [--now=<ISO>]`
(console transport prints the emails). Runbook in `infra/README.md`.

Cost: $0 (14M-invocation free tier; three rules ≈ 800 invokes/month).

### 3.9 Secrets — AWS Systems Manager Parameter Store

**Today:** `.env` files for local dev. On the deployed stack
(live-apply-validated 2026-06-07) the one runtime secret —
`DATABASE_URL` — lives in Parameter Store (SecureString, CMK), seeded
with a placeholder and set out-of-band so the real value never enters
Terraform state via that resource; the admin-MFA keys follow the same
path when set.

**Target:** unchanged — every runtime secret in Parameter Store, read
into Lambda env at deploy time, no hardcoded secrets anywhere.
Standard tier is free; the shop's needs fit comfortably in the limits
(10K parameters, 4 KB each).

### 3.10 Logs and alarms — Amazon CloudWatch

**Today:** Pino JSON logs land on `stdout` in dev; on the deployed
stack each Lambda writes to its own pre-created, CMK-encrypted
CloudWatch Log Group. Eight alarms defined in
`infra/observability.tf` (the always-free tier holds 10):

- 5xx rate > 1% over 5 minutes
- Failed admin logins > 5/hour (gated until admin-api exists)
- Lambda p99 duration > 5 seconds
- scheduler-fn Errors > 0 — a scheduled JOB threw; the Scheduler
  invokes Lambda async, so job failures only ever surface on this
  metric (ships with `enable_scheduler`, 2026-06-12)
- Scheduler delivery failure — an invocation EventBridge Scheduler
  could not deliver parked in the scheduler DLQ after its retry
  policy (ships with `enable_scheduler`, 2026-06-12)
- SES bounce rate > 5%
- Email DLQ depth > 0 — a durable-medium email exhausted its retries
  (inspect + redrive; ships with `enable_email_queue`, 2026-06-12)
- Email queue age > 15 min — the email-fn consumer is not draining
  (ships with `enable_email_queue`, 2026-06-12)

**SLO burn-rate alarms — shipped 2026-06-14 (Roadmap items 24/25).** A
*separate* set in `infra/slo.tf`, behind `enable_slo_alarms` (default off),
on top of the eight above: availability (fast-burn page + slow-burn ticket),
order-success (fast-burn page) and a p95 latency guard — multi-window
multi-burn-rate composite alarms over SLI metric filters on the `request_end`
log line. Objective contract in `infra/slos.yaml`; full detail in §8.5.
Composite alarms bill $0.50/mo each, so they are gated and cost $0 until on.

**Distributed tracing — shipped 2026-06-13 (Roadmap item 18).** The 2026
industry standard, OpenTelemetry, is now wired on shop-api: `@hono/otel`
request spans + undici/fetch downstream spans + Pino log↔trace correlation,
behind `ENABLE_TRACING`, exporting OTLP to X-Ray via the ADOT collector layer
(or any OTLP backend). See §8.2.

### 3.11 Certificates — AWS Certificate Manager (planned)

**Target:** ACM cert attached to CloudFront, auto-renewed. **Today:**
not provisioned.

### 3.12 CI/CD — GitHub Actions

**Today:** Four workflows in `.github/workflows/` plus a Dependabot
config (`.github/dependabot.yml`) —

- **`ci.yml`** — six parallel jobs (`typecheck`, `lint`,
  `auth-tests`, `email-tests`, `api-tests`, and `audit` — an
  informational `npm audit` plus a blocking gate on CRITICAL
  advisories in the production tree) on every PR and push to
  `main`. `api-tests` uses a Postgres 17 service container.
- **`codeql.yml`** — CodeQL `security-extended` query suite on
  JavaScript / TypeScript + the `actions` query pack on workflow
  YAML. Runs on PRs, push to `main`, and a Sunday 03:00 UTC weekly
  cron.
- **`sbom.yml`** — generates a CycloneDX 1.6 SBOM per workspace via
  `@cyclonedx/cyclonedx-npm`, signs each via
  `actions/attest-build-provenance` (GitHub OIDC → Sigstore Fulcio
  → Rekor), attaches to releases.
- **`infra.yml`** — gates `infra/` Terraform on PRs that touch it
  (`fmt` / `validate` / `tflint` / `checkov`); deploy-less.
- **`dependabot.yml`** (config, not a workflow) — automated, grouped,
  cooldown-gated dependency *version* updates across npm, GitHub
  Actions, Terraform, and Docker-Compose (Dependabot, not Renovate —
  see §9.6).

All four workflows pin third-party actions to commit SHAs, run
with top-level `permissions: contents: read`, set
`persist-credentials: false` on checkouts, and use
`concurrency.cancel-in-progress: true`.

**Gaps (deferred):**

- No frontend `tsc --noEmit` in CI (cross-workspace AppType inference
  issue documented in `README.md`).
- No `next build` in CI (would require API + seeded Postgres
  alongside the build).
- No branch protection enforcing the checks (one-time UI action, see
  §9.4).

**Future deployment automation:** on `main` push, Amplify would auto-
deploy the frontends; a planned GitHub Actions job would run
`terraform apply` and `aws lambda update-function-code` once
`infra/` exists.

---

## 4. The life of a request

Concrete walk-through against today's code, run locally. (For a
production walk-through against the target deployment, mentally
substitute "CloudFront" for "localhost" and "Lambda warm-invoke" for
"Node dev server"; the request shape is identical.)

A customer named Иван places an order:

1. Browser → `http://localhost:3000`. Next.js dev server returns the
   SSR'd home page.
2. The thin proxy at `frontend/src/proxy.ts` attaches a fresh nonce
   to the CSP and emits the Reporting-Endpoints header.
3. `getServerUser()` ran on the SSR pass, embedded "anonymous" into
   the response — no auth flicker. Home banners render from the live
   public `GET /banners` (roadmap item 47, 2026-06-29).
4. Иван clicks a product. `/products/[...path]` renders from
   mock-data today; in target state it calls `/products` and
   `/categories` on `shop-api`. The "Add to cart" button is a client
   component.
5. He clicks Add. `POST /cart/items` to `http://localhost:3001`. The
   API runs `INSERT … ON CONFLICT DO UPDATE` with `LEAST(qty+1, 99)`.
   Optimistic UI in `CartContext` updates first; rollback on a
   problem-type response.
6. He registers. `POST /auth/register`. Argon2id hashes
   (~150ms — intentional). Verification token generated
   (`crypto.randomBytes(32)`) and stored SHA-256-hashed. The
   `console` transport prints a `VERIFY URL ⇒` line to `api:dev`'s
   stdout. He clicks it, hits `POST /auth/verify-email`. Token
   hashed, looked up, `users.email_verified_at` set, cookie issued.
7. He checks out. UI generates an `Idempotency-Key` UUID, sends
   `POST /orders` with that header.
8. `shop-api` opens a Drizzle transaction:
   - `SELECT FOR UPDATE OF products` on the cart's products
   - re-check stock + prices
   - look up account discount
   - INSERT order header
   - INSERT line-item snapshots (productCode / productName /
     productImageS3Key / unitPriceCents)
   - seed status history
   - snapshot delivery address
   - clear the cart
9. Transaction commits, then the Bulgarian order-confirmation email
   fires best-effort (`orders.order-confirmation`, the EU 2023/2673
   durable-medium confirmation — wired 2026-06-04).
10. He sees the success page. Order number formatted
    `2026-05-00042` from a Postgres sequence + Sofia-month prefix.
11. Admin sees the new order at `/admin/orders` (real since
    2026-06-10 — list, filters, search) and on the `/admin` dashboard's
    recent-orders feed + realised-sales KPIs (real since 2026-07-06).
12. Days later, admin walks the order through the §7 state machine
    from the `/admin/orders/:n` detail page (`POST
    /admin/orders/:n/status` — optimistic-locked, audit-logged,
    each customer-visible hop emailing the customer). Marking it
    "accepted" starts the 14-day withdrawal clock; `accepted_at`
    gets a timestamp.
13. Иван decides to withdraw. He clicks "Откажете се от договора
    тук." Page POSTs to `/orders/:n/withdrawal`. Server inserts a
    `complaints` row (idempotently — partial unique index on
    `(order_id) WHERE reason='withdrawal'`). Two emails fire via
    `Promise.allSettled` — customer ack and admin notification.
    Both are best-effort.

(Until 2026-06-10, step 12 required manual psql — `UPDATE orders SET
status='accepted' …`. The admin orders slice retired that: every
transition now goes through the validated state machine, bumps the
optimistic-locking `version`, appends to `order_status_history` in
the same transaction, and notifies the customer.)

---

## 5. Security model

### 5.1 Threat model

Out-of-scope (the system does NOT defend against):

- Cardholder data exfiltration — there is none.
- Insider sabotage of the database — admin can run any query.
- AWS account root takeover — one hardware MFA away from total
  compromise.

In-scope threats and primary defences:

| Threat | Primary defence | Backstop |
|---|---|---|
| SQL injection | Drizzle parametrized queries everywhere | (Target) AWS WAF SQLi managed rules |
| Stored XSS | Next.js auto-escape + uniform strict CSP (`'nonce-X' 'strict-dynamic'`, see §5.2) + Hono `secureHeaders` on the API | (Target) WAF Common managed rules |
| CSRF | `SameSite=Lax` + `__Host-` cookie prefix + same-origin API | None needed |
| Session hijack | `HttpOnly` + `Secure` + 32-byte CSPRNG + SHA-256-at-rest | TLS 1.3 + HSTS preload |
| Credential stuffing | Per-email 5-fail / 15-min lockout + Argon2id timing wall | (Target) WAF rate-limit rules |
| Account enumeration | Constant-time login + identical 400 for "email in use" + identical 200 for forgot-password | RFC 9457 (no internal-state leakage) |
| Email-link phishing | Single-use, 1h tokens, SHA-256-hashed; reset drops all sessions; out-of-band notification | None |
| DDoS L3/L4 | (Target) AWS Shield Standard | None |
| DDoS L7 | (Target) WAF rate-limit rules + Lambda concurrency ceiling | None |
| Stolen cookie | Drop-all-sessions on reset/email-change; orphaned-cookie cleanup on `/auth/me` | Idle timeout (2h without "Remember me") |
| Admin compromise | ✅ TOTP MFA mandatory (`/admin/auth/*`, AAL2) + ✅ 30-min idle + ✅ 5-fail/30-min lockout; (Target) separate subdomain + stricter WAF | ✅ Replay-guarded single-use codes; secret AES-256-GCM at rest; uniform 404 (no surface enumeration) |
| Order replay | `Idempotency-Key` UNIQUE | None needed |
| Data-at-rest exfiltration | (Target) Neon encryption + S3 SSE | Tokens hashed; password hashes can't be reversed |
| Data-in-transit interception | TLS 1.3 + HSTS preload | CSP `upgrade-insecure-requests` |
| Supply-chain (malicious npm dep) | `package-lock.json` + Dependabot + `npm audit` in CI | CodeQL SAST + SBOM transparency |
| Business logic abuse (price manipulation) | Server-side recalculation on every order | Account-discount server-controlled, not client-supplied |

### 5.2 Content Security Policy

The May 2026 CSP slice shipped *twice* before landing on the right
design. This section documents the corrected design and notes the
rejected approach so the reasoning isn't relearned the hard way.

**Two-and-a-half facts about CSP in Next.js 16.**

1. A document's `Content-Security-Policy` is **fixed at HTML
   document load**. There is no specified way to change it on a
   running document. Soft navigation in an SPA reuses the document,
   so the CSP that applied at first load applies to every subsequent
   route the user navigates to via `<Link>`.
2. Next.js 16's official guide is explicit that **nonce-based CSP
   requires dynamic rendering**. Static / ISR / PPR pages are
   generated at build time when there is no request, so no nonce
   can be injected.
3. The shop's root layout reads cookies via `getServerUser()` to
   bootstrap auth identity without flicker. Reading cookies forces
   dynamic rendering. **Every route in this app is therefore
   already dynamic.** Earlier revisions of this doc that claimed
   "ISR for catalog pages" were technically inaccurate.

**The rejected hybrid design (May 16, 2026).** The first revision
applied a strict nonce-based CSP only to `/account/*` and `/admin/*`
via the proxy, and a permissive `'unsafe-inline'` baseline to the
catalog via `next.config.ts`. This works on hard navigations but
because the catalog uses `<Link>` to route into the account section,
a typical user wanders `/ → /products/123 → /account/login` via soft
navigation; the document's CSP never changes after that first load
on `/`, so inline-script protection on `/account/login` was silently
bypassed in the most common traffic pattern.

**The shipped design (May 19, 2026).** A single uniform strict CSP
applied to every HTML document via `frontend/src/proxy.ts`. The
proxy now matches every route (excluding Next.js internals, `/api`,
`/.well-known/`, and prefetch requests), and on every request:

1. Generates a 128-bit random nonce via
   `Buffer.from(crypto.randomUUID()).toString('base64')`.
2. Sets a forwarded `x-nonce` request header so any Server Component
   that needs a nonce on `<Script>` can read it via `await
   headers()`.
3. Sets a response `Content-Security-Policy` header AND a paired
   `Reporting-Endpoints` header:

   ```
   default-src 'self';
   script-src 'self' 'nonce-XXX' 'strict-dynamic' 'report-sample';
   style-src 'self' 'nonce-XXX' 'report-sample';
   img-src 'self' blob: data: https://cdn.duda1.bg;
   font-src 'self' data:;
   connect-src 'self' https://shop-api.duda1.bg;
   object-src 'none';
   base-uri 'self';
   form-action 'self';
   frame-ancestors 'none';
   upgrade-insecure-requests;
   report-to csp-endpoint;
   report-uri https://shop-api.duda1.bg/csp-report;
   ```

   ```
   Reporting-Endpoints: csp-endpoint="https://shop-api.duda1.bg/csp-report"
   ```

`'strict-dynamic'` means a script that carries the matching nonce is
trusted to load further scripts; nothing else loads, period. The
`'report-sample'` keyword on `script-src` / `style-src` gets the
browser to include a 40-char excerpt of the violating content in
the report body. In `NODE_ENV=development`, the policy adds
`'unsafe-eval'` to script-src and `'unsafe-inline'` to style-src for
React HMR — gated on dev only.

The soft-navigation trap is neutralised because every document
(catalog or account) ships with the same strict policy.

#### 5.2.1 Baseline security headers on every response

`frontend/next.config.ts` continues to set the rest of the
security-header set via `headers()`. CSP is intentionally **not**
set there. The non-CSP headers:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy:` — empty allow-list for every browser
  feature the shop doesn't use
- `X-Frame-Options: DENY` (redundant with `frame-ancestors 'none'`
  but covers ancient browsers)
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-site`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains;
  preload` (production builds only)

#### 5.2.2 The Hono API gets its own (stricter) CSP

`backend/shop-api/src/app.ts` wires `hono/secure-headers` with the
strictest possible policy for a JSON-only endpoint:

```
default-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'none';
```

Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-site`, HSTS, and
`X-Frame-Options: DENY`. This is defence-in-depth: meaningful only
if a browser ever evaluates the response as HTML (content-type
confusion). CORS in the `cors()` middleware remains the
authoritative gate for the fetch path.

#### 5.2.3 CSP violation reporting (shipped May 25, 2026)

`POST /csp-report` on `shop-api`. Accepts BOTH the modern Reporting
API v1 payload (`application/reports+json`, batched array of report
envelopes) AND the legacy `report-uri` payload
(`application/csp-report`, single wrapped object). The frontend
proxy emits TWO sink declarations on every HTML document — a
`Reporting-Endpoints: csp-endpoint=…` header paired with a
`report-to csp-endpoint` directive on the CSP (modern path), plus a
`report-uri …` directive (legacy fallback for older Firefox/Safari
that didn't reach baseline Reporting API support until March 2026).

Each well-formed violation produces one structured Pino
`csp_violation` event at warn level (`effectiveDirective`,
`blockedURL`, `documentURL`, `sourceFile`, `lineNumber`, `sample`,
etc.). Browser-extension noise (`chrome-extension://`,
`moz-extension://`, `safari-extension://`,
`safari-web-extension://`, `webkit-masked-url://`, `about:`, literal
`"null"`) is downgraded to debug level so alerts don't fire on
ad-blocker injection attempts. In-memory per-IP token bucket
(60/min, 10K tracked IPs max). Oversized bodies (>16 KiB) and
invalid JSON are silently dropped with an `info`-level
`csp_report_drop` event. Endpoint always returns `204 No Content`
(W3C Reporting API spec: any 2xx is success; reporters don't retry
on errors).

Closes the OWASP A09 visibility gap together with distributed tracing
(Roadmap item 18, shipped 2026-06-13 — §8.2), which was the last remaining
A09 item. A09 is now fully met.

#### 5.2.4 Verifying the policy is live

```bash
# Catalog homepage
curl -sI http://localhost:3000/ | grep -iE "content-security-policy|nonce|permissions-policy"

# Account login (soft-nav-safe: same strict policy as the catalog)
curl -sI http://localhost:3000/account/login | grep -iE "content-security-policy|nonce"

# API
curl -sI http://localhost:3001/health | grep -iE "content-security-policy|cross-origin|strict-transport"
```

Every shop response should contain `'nonce-X' 'strict-dynamic'`;
each request gets a different nonce. The API's CSP should be
`default-src 'none'`.

Browser-side: open `http://localhost:3000/csp-test.html`. The page
contains three intentionally-bad CSP inputs (a parser-inserted
inline script, an `onclick=` attribute, a `javascript:` URL) — all
three should be blocked, three `POST /csp-report` requests should
fire and each should 204, and three `csp_violation` log lines should
appear in `api:dev`.

The DevTools console isn't a valid test surface: pasting
`document.createElement('script')` + `appendChild` gives a false
negative under `'strict-dynamic'` because the console is treated as
a trusted script source.

### 5.3 What this maps onto

OWASP Top 10 2025, full coverage matrix, lives in `COMPLIANCE.md`.
Quick summary:

- A01 Broken Access Control — ✅ (two-tier middleware)
- A02 Security Misconfiguration (newly #2) — ✅ (uniform strict CSP
  + baseline security headers shipped)
- A03 Software Supply Chain Failures (expanded) — ✅ (SCA via
  Dependabot + `npm audit`; SAST via CodeQL `security-extended`;
  SBOM CycloneDX 1.6 per workspace; SLSA L2 signed provenance)
- A04 Cryptographic Failures — ✅
- A05 Injection — ✅
- A06 Insecure Design — ✅
- A07 Authentication Failures — ✅ for customers on password hygiene
  (NIST 800-63B-4 + HIBP + authenticated change-password). Admin
  MFA is documented but the admin Lambda isn't built yet — see §1.
  Customer MFA is a growth-stage roadmap item
- A08 Software & Data Integrity Failures — ✅ (Sigstore signing)
- A09 Security Logging Failures — ✅ CSP report endpoint ✅ +
  distributed tracing ✅ (OpenTelemetry, item 18, 2026-06-13)
- A10 Mishandling Exceptional Conditions (new) — ✅ (RFC 9457 +
  graceful degradation)

### 5.4 Compliance touchpoints

Brief; full mapping in `COMPLIANCE.md`:

- **GDPR Art. 32** (security of processing): ✅
- **GDPR Art. 16** (rectification): ✅ shipped May 23, 2026
- **GDPR Art. 17** (right to erasure): ✅ shipped May 24, 2026
- **GDPR Art. 15 + 20** (access + data portability): ✅ shipped
  May 31, 2026 — `POST /auth/me/export` (structured machine-readable JSON)
- **GDPR Art. 33–34** (breach notification 72h): ✅ shipped 2026-06-15
  — documented breach-response track in `docs/INCIDENT-RESPONSE.md` §6
  (Bulgarian CPDP/КЗЛД channels, awareness→72h decision tree, Art. 33(5)
  breach register, Art. 34 high-risk data-subject path + exceptions)
- **EU Directive 2023/2673** (14-day withdrawal): ✅ shipped
- **WCAG 2.2 Level AA / European Accessibility Act**: ✅ shipped
  2026-06-02 — EN 301 549 / WCAG 2.2 AA conformance (contrast-fixed
  tokens, keyboard + focus + skip-link, `prefers-reduced-motion`, ARIA
  combobox search, live-region errors) with a continuous audit (static
  `jsx-a11y` in CI + runtime `axe-core`/Playwright + manual checklist).
  See `docs/ACCESSIBILITY.md`, the `/accessibility` statement, §15 item 40
- **PCI-DSS**: n/a (no card data)
- **NIS2**: n/a at current scale
- **EU CRA**: **out of scope** — pure SaaS is exempt per the
  European Commission's own guidance; the shop has voluntarily
  adopted CRA-style hygiene (SBOM, RFC 9116 disclosure policy) as
  general supply-chain defence

---

## 6. Reliability model

### 6.1 Failure modes (target deployment)

| Failure | What the system does | What you do |
|---|---|---|
| Lambda cold start | One-off ~500ms latency | Nothing |
| Lambda crash | 500 returned; Pino logs; alarm if >1% in 5min | Read log, ship fix |
| Neon auto-suspend (Free) | First query 300–800ms wakeup | Upgrade to Launch in prod |
| Neon outage (Free/Launch) | DB calls fail; `currentUser` deliberately does NOT clear cookies on DB errors; WAF + alarm + email | Wait or upgrade to Scale |
| Neon outage (Scale) | Automatic failover, sub-10s impact | Nothing — that's what you pay for |
| SES outage | Queued emails retry automatically (SQS, item 21 — shipped 2026-06-12); account/order ops still complete; exhausted sends park in the alarmed DLQ | Redrive the DLQ from the SQS console after recovery |
| CloudFront degradation | Edge misses fall through to multi-AZ origin | Nothing — AWS handles |
| Amplify build failure | Atomic deploy: old version stays live | Fix and redeploy |
| Mass session compromise | `UPDATE sessions SET revoked_at=now()` via `db:psql` | Force server-side invalidation, notify customers |
| Logical data loss (DROP TABLE) | Neon PITR rolls back (7d on Launch, 30d on Scale) | Use Neon branch-and-restore |
| Catalog mistake | (Target) Daily S3 backup + admin-UI restore flow | (Target) Use admin "Restore from backup" |
| AWS regional outage | Hard down — no multi-region today | Wait (deferred Roadmap 25) |

### 6.2 RTO / RPO targets

Not yet formalised in code or alarms. Targets to adopt:

**At Neon Launch (recommended production posture):**
- RTO 1 hour
- RPO 5 minutes

**At Neon Scale (contractual-SLA posture):**
- RTO 5 minutes (automatic failover)
- RPO 1 minute (continuous replication)

### 6.3 Backup discipline

- **Daily catalog backup at 03:00 Sofia** — shipped 2026-06-12
  (scheduler-fn, §3.8): versioned + SSE-KMS + TLS-only bucket, 90-day
  lifecycle expiry, write-only IAM for the function (it cannot read or
  delete history). Deliberately catalog-only (no PII): customer/order
  recovery is Neon PITR's job; this artifact covers the one dataset
  the owner curates by hand, and doubles as the DR-drill seed (item
  19). Runs wherever `enable_scheduler` is on.
- **Neon PITR** is continuous on Neon — 7 days on Launch, 30 days on
  Scale.
- **DR drill cadence:** **never run.** Recommended quarterly once
  the production deployment exists. See §12.

---

## 7. Performance model

### 7.1 Targets (Core Web Vitals)

| Metric | Target | Status |
|---|---|---|
| LCP (Largest Contentful Paint) | <2.5s | Achievable; not measured continuously |
| INP (Interaction to Next Paint) | <200ms | Achievable; not measured continuously |
| CLS (Cumulative Layout Shift) | <0.1 | Achievable; not measured continuously |

Gap: no Lighthouse CI / WebPageTest synthetic monitoring.

### 7.2 Service-level objectives (shipped — `infra/slos.yaml`, item 24)

Defined as code in `infra/slos.yaml` (OpenSLO v1) since 2026-06-14, with
multi-window multi-burn-rate alarms in `infra/slo.tf` (item 25, behind
`enable_slo_alarms`):

| SLI | SLO | Window | Error budget | Alarmed |
|---|---|---|---|---|
| Availability (shop-api non-5xx of total) | 99.9% | 30 days | 43 min/mo | ✅ fast (page) + slow (ticket) |
| Order placement success (POST /orders non-5xx) | 99.9%¹ | 30 days | 43 min/mo | ✅ fast (page) |
| p95 latency (shop-api) | <1000ms² | 30 days | n/a | ✅ p95 guard |
| Availability (admin-api) | 99.5% | 30 days | 3.6 hr/mo | ⏸ admin-api not split out yet |
| p95 latency (search autocomplete) | <100ms | 30 days | n/a | ⏸ no per-route SLI yet |

¹ §15 item 24's original target was 99.95%; at low early order volume a single
failed checkout would breach that, so the alarm starts at 99.9% and tightens
with volume. ² The 200ms warm-path aspiration is kept as a goal; the SLO
threshold is 1000ms to leave headroom for occasional Lambda cold starts.

The SLIs are computed from the structured `request_end` log line (one per
request: `{ method, path, status, durationMs }`) via CloudWatch Logs metric
filters — so availability reflects the **actual HTTP status the app returns**,
a stricter signal than the legacy `api-5xx-rate` alarm (which reads AWS/Lambda
`Errors` and misses the 5xx that `app.onError` returns gracefully). Google's SRE
error-budget policy (green → yellow → orange → red) applies; the burn-rate
alarm tiers are its operational expression. See §8.5 and the "SLO + burn-rate
runbook" in `infra/README.md`.

### 7.3 Connection pooling

Each Lambda container: 3-connection pool, opened outside the handler.
Neon PgBouncer (transaction-pooled) handles up to 10,000 concurrent
client connections on the database side. Lambda can scale to 1,000
concurrent invocations without exhausting it.

---

## 8. Observability model

### 8.1 Current state

- **Structured Pino logs** with PII redaction, per-request child
  logger keyed on `X-Request-Id`. Works locally; lands in CloudWatch
  in target state. Every line now also carries `trace_id` / `span_id`
  when tracing is on (log↔trace correlation — §8.2).
- **(Target) CloudWatch Logs** with 14-day retention. Not deployed.
- **8 CloudWatch alarms** defined in `infra/observability.tf` (the 5xx
  and p99 ones live-applied 2026-06-07; the rest gated behind their
  feature flags).
- **SLO burn-rate alarms — shipped 2026-06-14** (`infra/slo.tf`, behind
  `enable_slo_alarms`): an additional multi-window multi-burn-rate set
  (availability, order-success, latency) on top of the 8 above. See §8.5.
- **Distributed tracing — shipped 2026-06-13** (OpenTelemetry on
  shop-api, Roadmap item 18). See §8.2.

### 8.2 Distributed tracing — OpenTelemetry (shipped 2026-06-13)

The 2026 default for serverless observability is **OpenTelemetry**.
shop-api now emits OTel traces, behind the `ENABLE_TRACING` flag
(`lib/tracing.ts`):

- **Request spans** come from `@hono/otel` (`httpInstrumentationMiddleware`,
  the outermost middleware in `app.ts`). Instrumenting at the **Hono**
  layer — not the Node HTTP server — means it fires identically on the
  local node-server and on Lambda, where Hono runs through the
  `hono/aws-lambda` adapter rather than an HTTP listener (the stock
  `instrumentation-http` would never see those invocations).
- **Downstream spans** come from `undici` (global `fetch`)
  instrumentation. It hooks Node's `diagnostics_channel`, so — unlike
  require-patching instrumentations — it survives the esbuild single-file
  bundle and captures what matters in production: the Neon serverless
  driver runs ordinary queries over an HTTPS `fetch`, and the HIBP check
  is a `fetch` too. (`pg`/`aws-sdk` auto-instrumentation is deliberately
  *not* wired — see §13 — because their require-time patching no-ops once
  the bundled app has eagerly imported those libraries; richer DB/SES
  spans are a future add via the ADOT layer's `--import` loader hook.)
- **Log↔trace correlation**: a Pino `mixin` stamps `trace_id` / `span_id`
  on every log line, and `X-Request-Id` is set as the `app.request_id`
  span attribute — so the three correlation handles (request id, trace,
  logs) are one. Start from a CloudWatch alarm, pivot to the trace, read
  every log line of that request.
- **Backend of choice**: spans export as OTLP to
  `OTEL_EXPORTER_OTLP_ENDPOINT`. In production that is the **ADOT
  collector Lambda layer** on `localhost:4318`, which forwards to **AWS
  X-Ray** (X-Ray-compatible trace ids via the AWS id generator +
  propagator, so our spans stitch onto the Lambda's Active-tracing root
  segment). Point the endpoint at Grafana Tempo / Honeycomb / Datadog
  instead and nothing else changes — the backend stays a single env var.
- **Lambda flush**: the execution environment freezes on return, so the
  handler force-flushes buffered spans in a `finally` (no-op when off).

Standardised semantic conventions (HTTP, FaaS, messaging). Infra:
`enable_tracing` + `adot_collector_layer_arn` (`infra/lambda.tf`); the
X-Ray write IAM rides on the existing `enable_xray_tracing` attachment.
Runbook in `infra/README.md`. **Cost when off is near-zero** — the heavy
OTel graph is dynamic-imported and never evaluated unless the flag is on.

### 8.3 Metrics that should exist but don't

- **DORA metrics**: deployment frequency, lead time for changes,
  MTTR, change failure rate.
- **Custom business metrics**: orders/hour, conversion-rate by
  funnel stage, withdrawal-rate. (Order-placement *success rate* now
  exists as an SLI — §8.5 — but the volume/funnel metrics do not.)
- **RUM (Real User Monitoring)**: actual user Core Web Vitals from
  browsers. Cloudflare Web Analytics (free, no cookie), Vercel
  Analytics, or self-hosted Plausible/Umami are all options.

### 8.4 CSP violation reporting

Shipped May 25, 2026 — see §5.2.3.

### 8.5 SLOs + burn-rate alerting (shipped 2026-06-14, items 24/25)

The objective contract is `infra/slos.yaml` (OpenSLO v1); the implementation is
`infra/slo.tf`, behind `enable_slo_alarms` (default off). See §7.2 for the SLO
table.

- **SLI source — the log line, not a metric API.** shop-api emits one
  structured `request_end` line per request: `{ method, path, status,
  durationMs }` (the `app.ts` request middleware). Five CloudWatch Logs
  **metric filters** extract the SLI metrics from it — total responses, 5xx,
  request duration, orders placed (POST /orders → 201), orders failed (POST
  /orders → 5xx). This is the same mechanism as the pre-existing
  admin-login-failures filter; there is **no `PutMetricData` call on the request
  path** and no new app dependency (the only code change was adding `method` +
  `path` to a log line that was already emitted). Trade-off: `request_end` is
  INFO-level, so the deployed Lambda must run at `log_level = "info"` — a
  plan-time precondition on the metric filter enforces this when the flag is on.
- **Why this is a stricter availability signal than the legacy 5xx alarm.** The
  `api-5xx-rate` alarm (§3.10) reads AWS/Lambda `Errors ÷ Invocations`, which
  only counts invocations that *threw* — it misses every 5xx that `app.onError`
  returns gracefully (the invocation "succeeded" from Lambda's view). The SLI
  reads the actual HTTP status from the log, so it sees those.
- **Corollary: a client error must never reach the 5xx bucket.** Because the SLI
  reads the real status and counts the graceful 500s `onError` returns, any client
  fault mislabelled as a 5xx would wrongly burn the availability budget. The global
  error handler therefore maps framework-level throws to their true status — above
  all a malformed JSON body to `400 /problems/malformed-json`, not 500 (§13, item
  45) — so the budget tracks *server* faults only, per the Google SRE 4xx-vs-5xx
  split.
- **Multi-window multi-burn-rate (Google SRE Workbook).** Each burn tier fires
  only when a **long and a short window both breach** (a CloudWatch composite
  alarm `ALARM(long) AND ALARM(short)`): the long window proves a sustained
  burn (noise suppression), the short window clears the alert quickly once the
  burn stops. Burn-rate threshold = multiplier × error-budget as an error-rate
  percent: fast 14.4× (1h/5m, page), slow 6× (6h/30m, ticket). Availability
  ships both tiers; order-success ships the fast-burn page tier; latency is a
  single p95 guard over 15 minutes (a lone cold start does not trip it).
- **AWS Application Signals SLOs considered + deferred** — see §13 and the
  header note in `infra/slos.yaml`. A finer rolling burn-rate (sub-window
  re-evaluation) is the documented next step; the window alarms use period =
  window length / evaluation_periods = 1, the same shape as the existing alarms.

---

## 9. Supply-chain security

### 9.1 What exists today

**Software Composition Analysis (third-party deps):**
- `package-lock.json` committed; `npm ci` everywhere for reproducible
  installs.
- **Dependabot alerts** enabled — GitHub-side advisory scanning of the
  dependency graph. The *passive* half: it tells you a CVE exists.
- **Dependabot version updates** (`.github/dependabot.yml`, 2026-06-16) —
  the *active* half: grouped, cooldown-gated PRs that keep dependencies
  current across all five ecosystems in this repo — **npm** (one root
  lockfile spans the five workspaces), **GitHub Actions** (bumps the SHA
  pins *and* their `# vX.Y.Z` comments — native since 2022), **Terraform**
  (root + `bootstrap` stacks), and the **Docker Compose** Postgres image
  (major pinned to 17, see the config). `cooldown` refuses any release
  younger than 5–14 days — the 2025/2026 defense against compromised
  *fresh* releases (the tj-actions- and npm-"Shai-Hulud"-class attacks the
  CI header references); security updates still fire immediately. See §9.6
  for why Dependabot and not Renovate.
- **`npm audit` gate in CI** — the `audit` job in `ci.yml` runs an
  informational all-severity audit (never blocks) plus a blocking gate on
  **critical** advisories in the production tree
  (`npm audit --omit=dev --audit-level=critical`). Critical-only is
  deliberate: it is the low-false-positive tier (~40–50% vs ~80%
  all-severity), and the production tree currently carries a few `high`
  transitive advisories (pulled in under Next.js) that Dependabot patches
  on its own cadence — a `high` gate would wedge CI red on day one. Routine
  upkeep is Dependabot's job; this gate is the emergency brake. (This
  reconciles the earlier doc claim that `npm audit` "runs in CI", which
  predated the job actually existing.)

**Static Application Security Testing (first-party code):**
- **GitHub CodeQL** in `.github/workflows/codeql.yml`.
  - `security-extended` query suite on JavaScript/TypeScript.
  - `actions` query pack on workflow YAML (catches the
    tj-actions-style supply-chain compromise pattern).
  - Runs on every PR, every push to `main`, and a Sunday 03:00 UTC
    weekly cron.

**Software Bill of Materials (SBOM):**
- **CycloneDX 1.6 JSON** per workspace, in
  `.github/workflows/sbom.yml`.
- Generated via `@cyclonedx/cyclonedx-npm@^2.0.0` with
  `--package-lock-only --omit dev` (production bundle only).
- One per deployment unit: `sbom-frontend.cdx.json`,
  `sbom-backend-db.cdx.json`, `sbom-backend-auth.cdx.json`,
  `sbom-backend-email.cdx.json`, `sbom-backend-api.cdx.json`.
- Uploaded as workflow artifacts (90-day retention) on every push;
  attached to GitHub Releases on every published tag.

**Build provenance & artifact signing (SLSA Level 2):**
- Each SBOM is signed via
  `actions/attest-build-provenance@v4.1.0`, producing an in-toto
  SLSA v1.0 build-provenance attestation using GitHub OIDC →
  Sigstore Fulcio → Rekor transparency log.
- No long-lived signing keys. The signing identity IS the GitHub
  Actions workflow execution context.

**Vulnerability disclosure (RFC 9116):**
- `frontend/public/.well-known/security.txt` published.
- Bilingual policy page at `/security` (Bulgarian + English),
  aligned with ISO/IEC 29147:2018.

**CI workflow security:**
- All third-party actions pinned to 40-char commit SHAs.
- Top-level `permissions: contents: read`.
- `persist-credentials: false` on every checkout.
- `concurrency.cancel-in-progress: true`.

### 9.2 What's intentionally NOT here

| Practice | Why deferred | When to revisit |
|---|---|---|
| **Signed commits** (GPG / SSH) | Single-committer repo. Branch protection on `main` + CodeQL on PRs covers integrity. | When a second human commits to `main`. |
| **SLSA Level 3** | Requires reusable workflow with build-platform isolation. Overkill for a shop with no third-party consumers of build artifacts. | If a customer requires a contractual provenance SLA. |
| **Dependency Track / OWASP DC server** | SBOMs are produced and signed; an external scanner can ingest them on demand. | When dep count > ~500 transitive or compliance asks for one. |

### 9.3 SLSA status

**Achieved: SLSA Level 2.** GitHub Actions is a hosted build
platform (L2 build platform requirement), and every artifact carries
a signed in-toto provenance attestation queryable via Rekor (L2
provenance requirement).

**Level 3** would require a reusable workflow in an isolated
context, hermetic builds, and build-platform-signed provenance. Defer
until contractual need (Roadmap item 39).

### 9.4 Branch protection runbook (one-time setup)

Branch protection is the only Week 1 item that can't be checked
into the repo. Run this once per repository; verify quarterly.

**Solo-committer rules (today):**

- ☑ Require a pull request before merging
  - **Require approvals: 0** ← critical. GitHub forbids approving
    your own PR; any non-zero value deadlocks a solo-committer repo.
  - ☑ Dismiss stale pull request approvals when new commits are
    pushed
  - ☑ Require conversation resolution before merging
- ☑ Require status checks to pass before merging
  - ☑ Require branches to be up to date before merging
  - Required status checks:
    - `Typecheck (all workspaces)`
    - `Lint (frontend)`
    - `Auth tests`
    - `Email tests`
    - `API tests (Postgres)`
    - `Dependency audit (npm)`
    - `Analyze (javascript-typescript)`
    - `Analyze (actions)`
    - `SBOM (frontend)`
    - `SBOM (backend-db)`
    - `SBOM (backend-auth)`
    - `SBOM (backend-email)`
    - `SBOM (backend-api)`
- ☐ Require signed commits — defer (see §9.2).
- ☑ Require linear history — keeps `git log` bisectable.
- ☐ Do not allow bypassing the above settings — leave UNCHECKED in
  solo mode to retain an emergency override.
- ☐ Allow force pushes — leave unchecked.
- ☐ Allow deletions — leave unchecked.

**Multi-committer rules (when a second human commits):**

- ☑ Require approvals: 1 (now the second-pair-of-eyes gate works).
- ☑ Require signed commits.
- ☑ Do not allow bypassing the above settings.
- ☑ Require review from Code Owners if you add a `CODEOWNERS` file.

**Required-status-check deadlock — the "skipped check" gotcha:** do
not add a `paths:` or `paths-ignore:` filter to the `pull_request:`
trigger of any workflow whose status checks are marked as required.
If such a workflow doesn't fire on a given PR, the required checks
never report, and the PR sits in "Waiting for status." We hit this
once with `sbom.yml` having a paths filter; removed.

**Verification:**

```bash
git checkout main
git commit --allow-empty -m "test: branch protection should block this"
git push
# Expect: ! [remote rejected]   main -> main (protected branch hook declined)
```

### 9.5 Verification (downstream consumer view)

Anyone — auditor, customer, security researcher — can independently
verify any published SBOM:

```bash
# Using GitHub's CLI (easiest):
gh attestation verify sbom-backend-api.cdx.json \
  --owner Filip-Ermenkov

# Using cosign directly against the public Rekor log:
cosign verify-blob sbom-backend-api.cdx.json \
  --bundle sbom-backend-api.cdx.json.sigstore \
  --certificate-identity-regexp \
    '^https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever/.+' \
  --certificate-oidc-issuer \
    https://token.actions.githubusercontent.com
```

Either command succeeds only if the SBOM byte-for-byte matches what
was signed, the signing identity is a workflow in this repository,
and the signature appears in the Sigstore Rekor transparency log.

### 9.6 Automated dependency updates — Dependabot, not Renovate

The repo had the *passive* half of SCA (Dependabot alerts + signed SBOMs)
but, until 2026-06-16, nothing that actually *opened PRs* to keep
dependencies current — the active control that keeps a codebase out of the
OWASP 2025 "Vulnerable & Outdated Components" bucket and lets it **age
well**. `.github/dependabot.yml` ships it. The tool choice was deliberate.

**Why Dependabot.** Renovate is the more powerful engine for large,
**multi-lockfile** monorepos (workspace-aware coordination, org-wide shared
presets, aggressive cross-ecosystem auto-merge). None of those edges apply
here, and its operating model conflicts with this project's posture:

- **Zero new trust surface.** Renovate runs either as the Mend-hosted
  GitHub App — a third-party app granted write access to this repo's PRs,
  i.e. a fresh supply-chain trust relationship on a security-first repo — or
  self-hosted via an Action driven by a long-lived PAT
  (`contents: write` + `pull-requests: write`). Dependabot is a first-party
  GitHub feature with a GitHub-managed, per-run identity: no third-party
  app, no long-lived token, no new infra. This is the *same* reasoning that
  picked **keyless** Sigstore signing (§9.1) and rejected standing infra
  like Redis / DynamoDB / a Dependency-Track server (§9.2, §13).
- **The one Renovate-only capability we'd have needed is now native.**
  Keeping a **SHA-pinned** GitHub Action readable means bumping the digest
  *and* the trailing `# vX.Y.Z` comment together. Dependabot has done this
  since 2022, so the post-tj-actions hardening (§9.1, §12 of `ci.yml`) stays
  intact under automation.
- **One root lockfile.** The five npm workspaces resolve through a single
  `package-lock.json`, so npm updates are already unified — Renovate's
  headline multi-lockfile advantage buys nothing at this scale. Dependabot's
  now-GA **grouped** version *and* security updates keep PR volume low.

**Supply-chain hardening in the config.** `cooldown` (5–14 days, longest on
npm) refuses any release younger than the window — the 2025/2026 mitigation
for *compromised fresh releases*, where a malicious version is published and
yanked within days. It applies to version updates only; a security update
for an already-published CVE still opens immediately. Grouping is declared
for both version and security PRs so review surface stays small. The
Postgres image ignores `semver-major` (a 17→18 jump is a coordinated Neon +
CI + compose migration, never an automated PR).

**Renovate reconsider triggers.** Move to Renovate if the repo grows
**independent lockfiles per workspace** (true monorepo coordination), wants
**org-wide shared presets** across many repos, or wants **auto-merge** of
patch/lockfile-only updates behind required checks — Renovate's policy
engine is materially better there, and at that point the Mend App's trust
cost is worth paying.

This pairs with **OpenSSF Scorecard's `Dependency-Update-Tool` check**, which
a committed `dependabot.yml` satisfies — a public, machine-readable signal of
the posture alongside the SLSA provenance.

---

## 10. Cost model

### 10.1 Target pricing

| Tier | PV/mo | Cost (Neon Free, dev) | Cost (Neon Launch, prod) |
|---|---|---|---|
| 0 — Idle | 0 | €6.90 | €24.62 |
| 1 — Start | 2K | €6.92 | €24.64 |
| 2 — Small | 20K | €7.10 | €24.83 |
| 3 — Growth | 100K | €7.92 | €25.64 |
| 4 — Busy | 400K | n/a | €28.64 |
| 5 — Big | 2M | n/a | €70.00 |

**Decomposition of Tier 4 (€28.64):** Neon Launch is 62% ($19.26);
AWS WAF + Route 53 is 34% ($10.60 between fixed + per-request);
everything else (CloudFront, Lambda, Amplify SSR, S3) is free at
this scale.

**Today's actual cost:** €0/mo — nothing is deployed.

### 10.2 Recommended swap: Cloudflare edge

The single biggest unforced overpayment in the target topology is
**AWS WAF + Route 53**. Cloudflare's Free tier provides:
- Unmetered L3/L4/L7 DDoS (stronger than AWS Shield Standard)
- Free TLS certs
- Free DNS
- Cloudflare-managed Free WAF ruleset
- Bot Fight Mode
- Unlimited CDN bandwidth for static assets
- HTTP/3 / QUIC

Migration paths:

**A1 — DNS-only + R2 for images.** Half a day. Saves €0.50/mo.
Eliminates two AWS lock-in points. No-regret. Do this first.

**A2 — Cloudflare Free proxy (also replaces WAF).** One day. Saves
€7–10/mo at Tier 0–3, €10/mo at Tier 4, €42/mo at Tier 5.

**A3 — Cloudflare Pro proxy ($25/mo).** Strictly stronger security:
full Cloudflare Managed Ruleset + OWASP CRS + custom WAF rules +
rate-limit rules + ML bot scoring + Page Shield. €13–16/mo more at
Tier 0–4, €19/mo less at Tier 5.

### 10.3 Recommended tier table (after A1+A2)

| Tier | Products | Visitors/mo | PV/mo | Orders/mo | Cost |
|---|---|---|---|---|---|
| 0 — Idle | 0 | 0 | 0 | 0 | **€0/mo** |
| 1 — Start | 50 | 500 | 2K | 10 | **€0/mo** |
| 2 — Small | 250 | 5,000 | 20K | 100 | **€18/mo** (Neon Launch) |
| 3 — Growth | 1,000 | 25,000 | 100K | 500 | **€18/mo** |
| 4 — Busy | 3,000 | 100,000 | 400K | 2,000 | **€19/mo** |
| 5 — Big | 5,000+ | 500,000 | 2M | 10,000 | **€28/mo** |

### 10.4 Other cost optimisations

- **CloudWatch Logs retention** — set to 14 days from the start.
- **Cost alerts via AWS Budgets** at $30/mo.
- **AWS Customer Carbon Footprint Tool** — quarterly review.

---

## 11. Day-to-day operations

**None of this runs today.** This section describes the target
operational cadence for after the production deployment.

### Daily (automated, target)

- 03:00 Sofia — catalog backup runs
- Hourly — expired-pickup-deadline check
- 04:00 Sofia — unverified accounts older than 7 days deleted
- Continuous — CloudWatch alarms

### Weekly (5–10 min)

- Glance at AWS Budgets dashboard
- Review Dependabot PRs, merge green ones

### Monthly (~30 min)

- CloudWatch Logs Insights query for 4xx/5xx patterns
- Check Neon usage dashboard
- SES reputation: bounce rate < 5%, complaint rate < 0.1%

### Quarterly (~1–2 hours)

- **DR drill** — restore a Neon branch from backup, verify (the
  recovery half of `docs/INCIDENT-RESPONSE.md`)
- **Incident tabletop** — walk one `INCIDENT-RESPONSE.md` §5 scenario
  end to end (which alarm, which runbook, what to file with the CPDP)
- IAM policy review (AWS Access Analyzer flags unused permissions)
- AWS announcements review (Lambda runtime EOLs, Neon platform
  changes)

### Yearly

- Postgres major upgrade if Neon prompts
- Rotate admin AWS user's hardware MFA
- Re-run threat model (§5.1)
- Re-run AWS Well-Architected Review

### On-incident triage order

1. Is it the database? `db:psql`; `SELECT 1`; check
   `status.neon.tech`.
2. Specific Lambda? CloudWatch Logs → filter by `X-Request-Id`.
3. Frontend? Amplify build history.
4. Edge? CloudFront status, WAF rule firing rate.
5. Email? SES Console reputation tab.

Document every incident — even 5-minute ones. The first incident
with no postmortem is the start of a culture of forgetting.

The full incident-response playbook — the severity model, the
detect→triage→contain→eradicate→recover lifecycle, the scenario
playbooks that dispatch to the §12 runbooks, the GDPR Art. 33/34 breach
track, and the postmortem + breach-register templates — is
`docs/INCIDENT-RESPONSE.md` (Roadmap item 31). It is the umbrella that
calls the §12 procedures.

---

## 12. Disaster recovery

### 12.1 What can be lost

- **Database** — recoverable to any point in the last 7d (Launch)
  or 30d (Scale) via Neon PITR.
- **Catalog structure** — (target) recoverable from daily S3 backup.
- **Customer accounts and orders** — recoverable from Neon PITR.
- **Order line snapshots** — frozen onto each order row at checkout.
  Survive any catalog edit or restore.

### 12.2 Procedure (Neon PITR)

```
1. Identify target timestamp.
2. In Neon console: create a new branch from PITR at that timestamp.
3. Run a verification query — confirm row counts, sample data.
4. Switch NEON_DATABASE_URL in SSM Parameter Store to the new branch.
5. Redeploy Lambdas (so they pick up the new env var).
6. Verify a few requests against the live shop.
7. (Optional) Promote the new branch to "main" in Neon, archive old.
```

Drill quarterly. Document each run. **Never been drilled today.**

### 12.3 Procedure (catalog restore from S3 backup)

```
1. Admin panel → Archive → Choose a date → Preview → Restore
2. Confirm warning
3. Click Confirm
4. Watch the audit log entry appear
```

**Today:** the BACKUP half is real (2026-06-12, live-validated
2026-06-13): scheduler-fn writes the daily snapshot and indexes it in
`catalog_backups` (kind='scheduled', one row per key), and since the
archive slice (item 51, 2026-07-07) the admin can also take an on-demand
`kind='manual'` snapshot from `/admin/archive` (`POST /admin/archive/backup`).
The RESTORE half is now PARTLY real: the admin Archive page lists the
snapshots and restores **individual** soft-deleted products/categories
(per-item un-archive). Replaying a **whole** snapshot back over the live
catalog is still deferred (item 52); until it ships, a full restore = read
the S3 object and replay it manually (psql / a one-off script).

### 12.4 Procedure (admin MFA seed lost)

**Status:** Admin MFA shipped 2026-06-08 (`/admin/auth/*`, mandatory
TOTP). This procedure covers a lost TOTP seed; the single-use recovery
codes issued at enrolment are the primary recovery path, with the SQL
reset below as the last-resort break-glass.

The shop has exactly one administrator account, gated by mandatory
TOTP MFA on a separate subdomain (target state). Losing the TOTP
seed without a documented recovery path would be the single most
likely catastrophic failure mode.

#### 12.4.1 Where the seed is stored (set up once)

1. **Primary copy: password manager vault.** TOTP seed
   (`otpauth://` URI) as a secure note in 1Password / Bitwarden /
   iCloud Keychain.
2. **Off-vault backup: paper recovery codes** in a tamper-evident
   envelope in a physical safe.
3. **Off-site copy of the cloud backup.** Password manager 2FA
   enabled + recovery kit printed alongside the TOTP envelope.

The seed file is **never** stored in: this repository, any
unencrypted document, any chat history, any email, Parameter Store,
or any cloud service the admin account itself controls.

#### 12.4.2 Recovery — Scenario A: TOTP device lost, seed preserved

Easy case. Copy the URI from the password manager into a fresh
authenticator app on a new device. Log in. Rotate the seed via
Admin → Security → "Rotate TOTP seed." 5–15 minutes.

#### 12.4.3 Recovery — Scenario B: TOTP device + password manager both lost

Retrieve the paper envelope. Enter one unused recovery code. Rotate
the seed. 15–30 minutes plus physical retrieval.

#### 12.4.4 Recovery — Scenario C: everything lost

Break-glass. SSH into AWS (root credential is stored in a separate
hardware-MFA-protected channel). Connect to Neon via the SSM
connection string. Disable MFA in psql:

```sql
UPDATE users SET totp_secret = NULL, totp_verified_at = NULL
  WHERE email = '<admin-email>';
```

Log in with password only. Re-enrol TOTP. Audit-log the recovery.
1–2 hours.

#### 12.4.5 Drill cadence

Run Scenario A annually with the yearly checklist (§11). Do not run
Scenario C against production — practise it against a Neon PITR
branch.

---

## 13. Architecture decisions locked in

These are baked-in for good reasons; revisiting them costs you weeks.

- **Drizzle, not Prisma** — Lambda bundling + raw-SQL escape hatches;
  cold start under 500 ms versus Prisma's 1–3 s.
- **Money as integer cents** — float arithmetic loses money.
- **`timestamptz` always** — naïve timestamps are a bug magnet.
- **Neon, not RDS** — RDS forces a VPC which adds NAT Gateway
  ($32/mo) and slows Lambda cold-starts by 300–500ms.
- **Neon serverless driver: HTTP for queries, WebSocket for
  transactions** (2026-06-13) — `createDb()` uses the
  `@neondatabase/serverless` `Pool` with `poolQueryViaFetch=true`, so
  ordinary queries cross one stateless HTTPS fetch (the
  connection-storm-free property the prod target was chosen for) while
  an interactive `db.transaction(...)` opens a WebSocket for that
  transaction only. The plain `neon-http` driver was the original
  choice but THROWS `No transactions support in neon-http driver`, and
  the app relies on interactive transactions in checkout, registration,
  password reset, email change/verification, account deletion, admin
  order transitions and the scheduler jobs — so the runtime driver MUST
  support them (caught by the live catalog-backup drill, which ran
  against Neon for the first time). `channel_binding=require` is
  stripped for the WebSocket transport (the wss tunnel is the TLS layer,
  so pg-level channel binding has nothing to bind to) and
  `webSocketConstructor` is the Node 22 global — no `ws` dependency.
  Rewriting every transaction into single statements was rejected: it
  sacrifices atomicity the domain needs and touches every write path,
  where a one-file driver swap fixes it behind the unchanged `DbClient`
  interface (zero call-site changes).
- **Hono on Lambda** — same handler runs on Workers/Bun/Node, so
  the deployment target can change without rewriting the API.
- **Zod 4 + `@hono/zod-openapi`** — the API contract is the code.
- **RFC 9457 Problem Details** — every error has a consistent shape.
- **Cursor (keyset) pagination on the PUBLIC catalog** — offset
  pagination is O(n) and drifts under concurrent inserts. Deliberate
  exception (2026-06-10): the ADMIN `/admin/orders` list uses offset
  pagination — a back-office table needs a total count and
  "page N of M" controls (spec: 25/page, buttons top + bottom), the
  audience is one admin, and `(status, created_at)` is indexed.
- **Order status transitions are a server-validated state machine**
  (2026-06-10) — `lib/order-status.ts` encodes the §7 lifecycle 1:1;
  the admin UI renders the server-computed `allowedTargets`, never
  its own table. Illegal hop → 409 `/problems/invalid-status-transition`;
  stale `expectedVersion` → 409 `/problems/order-version-conflict`
  (version-in-payload optimistic locking per the spec's UI contract,
  with the audit `order_status_history` INSERT in the same
  transaction as the UPDATE).
- **`__Host-`-prefixed cookies in prod** — the prefix forbids
  unsecure transmission, cross-domain leaks, and HttpOnly bypass.
- **Argon2id `m=19456, t=2, p=1`** — RFC 9106 + OWASP 2024 low-
  memory recommended profile.
- **32-byte CSPRNG session tokens, SHA-256-hashed at rest**.
- **Constant-time login** — defeats email enumeration via timing.
- **Per-email brute-force lockout, not per-IP** — IP-based lockout
  is bypassable from one mobile-tether reconnect.
- **Two-tier auth middleware** (`currentUser` best-effort +
  `requireAuth` gate) — anonymous-and-authenticated routes share
  paths.
- **Orphaned-cookie cleanup in `currentUser`** — prevents the
  `/login → /profile → /login` redirect loop.
- **CORS with credentials, allowlist origins** — wildcard +
  credentials is rejected by browsers.
- **Two-mode cart** — `sessionStorage` guest, server-persisted user.
- **Order line items snapshotted** — historical orders survive
  catalog edits.
- **`Idempotency-Key` UNIQUE on orders** — partial unique index IS
  the idempotency boundary; no separate Redis needed.
- **`accepted_at` is the canonical withdrawal-window start**.
- **Best-effort email sends** — registration / reset / withdrawal
  never roll back on email failure.
- **Email durability is a queue behind the transport interface, not
  retry loops in the app** (2026-06-12) — `EMAIL_TRANSPORT=sqs`
  enqueues the RENDERED email (versioned envelope, producer and
  consumer in `@shop/email` so the contract can't drift); the email-fn
  Lambda owns the SES call. Standard queue (at-least-once; a rare
  duplicate beats a lost durable-medium email), partial-batch
  responses (`ReportBatchItemFailures` — a failed record never
  re-sends its batch-mates), every failure mode → redelivery → DLQ +
  alarm (no permanent-vs-transient cleverness hiding mail in logs),
  SSE-KMS on the queue because rendered bodies are personal data.
  Optimistic SES-then-queue hybrids were rejected: one code path,
  and SES latency leaves the request path entirely.
- **Scheduled jobs are idempotent sweeps with claim markers in the
  domain tables, not a workflow engine** (2026-06-12) — EventBridge
  Scheduler (IANA-timezone cron, the purpose-built service) async-
  invokes scheduler-fn; every job re-derives its work from the
  database and CLAIMS each side effect in the same UPDATE that
  selects it (`pickup_expired_notified_at`,
  `unverified_deletion_warning_at`), so at-least-once delivery,
  Lambda's async retries and overlapping runs are all harmless. The
  Postgres marker IS the idempotency store — no DynamoDB/Powertools
  layer for three tiny crons. No job-level DLQ either: the next cron
  tick is the redrive; alarms (not redrives) get a human when a job
  fails persistently. Unverified accounts are HARD-deleted (vs the
  pseudonymising account-deletion routine): an unverified customer
  cannot own orders, so nothing is legally retained — guarded by a
  `NOT EXISTS(orders)` rail. Deletion at day 7 does not wait for the
  day-6 courtesy warning to have succeeded — storage limitation
  outranks courtesy, and the alternative (a bouncing address blocks
  deletion forever) is an unbounded-retention bug. The catalog backup
  is catalog-ONLY: zero personal data, so erasure requests never
  collide with backup retention.
- **Distributed tracing is in-bundle OpenTelemetry behind a flag, not
  the ADOT auto-instrumentation layer** (2026-06-13) — request spans
  come from `@hono/otel` at the Hono layer (fires on Lambda, where
  there is no Node HTTP server for `instrumentation-http` to hook) and
  downstream spans from `undici`/`diagnostics_channel` (the one
  instrumentation that survives the esbuild single-file bundle, and the
  one that matters in prod: the Neon serverless driver and HIBP both go
  over `fetch`). `pg`/`aws-sdk` auto-instrumentation was deliberately
  REJECTED: they patch their target at require-time, which silently
  no-ops once the bundled handler has eagerly imported those modules —
  shipping dead instrumentation would be worse than omitting it. Export
  is vendor-neutral OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`; the prod path
  is the **ADOT collector layer** (it owns the SigV4 + X-Ray
  translation, so the app stays a plain OTLP emitter and the backend is
  swappable per §8.2). The collector-LESS direct-to-X-Ray-OTLP endpoint
  (Nov-2024 GA) was considered and deferred: it needs SigV4-signed
  exports + Transaction Search enabled, more moving parts than a tiny
  shop needs today, and the loader-hook path also unlocks `pg`/`aws-sdk`
  spans when that day comes. Tracing is feature-flagged
  (`ENABLE_TRACING`, default off) and the heavy graph is dynamic-imported
  so the cold-start cost is paid only when it is on — the same
  ride-behind-a-flag discipline as the email queue and scheduler. X-Ray
  id generator + propagator keep our trace ids compatible with the
  Lambda's own Active-tracing segment. The alternative — hand-rolling a
  SigV4 OTLP exporter, or wiring the heavyweight ADOT SDK auto-instrument
  layer (cold-start cost + double-wrapping our own spans) — bought
  nothing the curated in-bundle setup doesn't.
- **SLOs are OpenSLO-as-code + log-derived SLIs + multi-window burn-rate
  composites, not AWS Application Signals** (2026-06-14) — the objective lives
  in `infra/slos.yaml` (OpenSLO v1, vendor-neutral — the same portability stance
  as the OTel tracing choice), and the SLIs are CloudWatch Logs **metric
  filters** over the `request_end` log line the app already emits (one enriched
  field, no `PutMetricData` on the hot path, no new dependency). Alarms are the
  Google SRE Workbook multi-window multi-burn-rate pattern as CloudWatch
  **composite alarms** (long AND short window). AWS Application Signals SLOs
  (GA Nov 2024, native burn-rate) were REJECTED for now: they require the ADOT
  auto-instrumentation layer this project deliberately does not run (the tracing
  decision above — we self-instrument in-bundle and must not be double-wrapped),
  they are AWS-proprietary (against the OpenSLO/OTel posture), and they bill
  per-SLO + per-monitored-metric. The log-filter path reuses the existing,
  mostly-free CloudWatch observability and keeps the objective portable. The
  cost: availability is reflected from the app's own returned status (a stricter
  signal than the Lambda-Errors-based `api-5xx-rate` alarm), at the price of
  requiring `log_level = "info"` on the deployed Lambda (a plan-time precondition
  enforces it) and the clock-aligned window cadence of CloudWatch metric-math
  alarms (a finer rolling burn-rate is the documented next step). Behind
  `enable_slo_alarms`, default off — the same ride-behind-a-flag discipline as
  the email queue, scheduler, and tracing.
- **Category management uses adjacency-list traversal + `updatedAt`/`FOR
  UPDATE` optimistic locking + cascade soft-delete with 301 redirects**
  (2026-06-15) — the `/admin/categories/*` slice. (1) The tree stays the
  existing `parent_id` **adjacency list**: for a catalog of a few dozen
  categories with frequent moves that is the right model — closure tables /
  `ltree` only earn their write-amplification and index cost past hundreds of
  nodes. Descendant collection and the move cycle-check are in-memory walks
  over the flat live rows (`lib/category-tree.ts`), the same call the public
  tree route already makes. (2) Categories carry no integer `version` column
  (orders do), and adding one is a migration we avoided; instead the mutating
  endpoints take the `updatedAt` the admin's screen rendered from as
  `expectedUpdatedAt`, re-read the row `SELECT … FOR UPDATE` inside the
  transaction, and compare in JS at millisecond precision. The row lock makes
  read-compare-write atomic (no lost update), and the JS compare sidesteps the
  Postgres-microsecond vs JS-millisecond equality pitfall a `WHERE updated_at
  = $1` guard would hit. RFC 7232 `If-Match` was rejected for the same reason
  as on orders (the CDN plays ETag games on GETs). (3) Delete is a **cascade
  soft-delete** (the subtree + its products' `deleted_at`), and for every
  removed URL we write a `redirects` row to the nearest surviving ancestor
  (the deleted subtree's parent, or home for a deleted root) so old links 301
  instead of becoming soft-404s — the e-commerce SEO best practice, and the
  first writer of the long-dormant `redirects` table. Order history is never
  touched (it snapshots line items; we soft-delete, so the
  `order_items.product_id` SET-NULL-on-hard-delete never fires). Every
  mutation appends to `admin_audit_log` (GDPR Art. 30) — also its first
  writer. Serving the 301 at the edge (proxy-side `redirects` consumption) is
  the paired follow-up; the rows are written and correct now.
- **Single admin account** — multi-admin is out of scope.
- **Uniform strict CSP** — defends against the SPA-soft-navigation
  bypass documented in §5.2.
- **Dependabot, not Renovate, for automated dependency updates**
  (2026-06-16) — the first-party feature adds the capability with zero new
  third-party trust surface, zero infra, and no long-lived tokens (Renovate
  needs the Mend GitHub App or a self-hosted PAT), matching the
  keyless-Sigstore / no-standing-infra posture. Native SHA-pin +
  version-comment bumping covers the one thing Renovate would have been
  needed for, and the five npm workspaces share one root lockfile so
  Renovate's multi-lockfile edge doesn't apply. Cooldown-gated + grouped
  PRs across npm / Actions / Terraform / Docker-Compose; a critical-only
  `npm audit` gate is the emergency brake. Full rationale in §9.6.

---

### 13.x Guest order-tracking token — durable plaintext capability URL

The spec (§7) gives guests a tracking link with "криптографски случаен токен …
валиден безсрочно". Three design choices, all deliberate:

- **Capability URL, not a magic link.** The token grants read access to ONE
  order plus two status-gated actions (cancel while `processing`; withdraw while
  `accepted` and < 14 days). It never escalates privilege or touches another
  order. So the magic-link rulebook (10–15 min expiry, single-use) does NOT
  apply; the W3C TAG "Good Practices for Capability URLs" model does. It is
  **durable** because the product contract requires last-week's email to still
  open the order.
- **256-bit, CSPRNG, base64url.** `crypto.randomBytes(32)` →
  `lib/guest-track.ts`. The previous `crypto.randomUUID()` carried 122 random
  bits — just under OWASP's ≥128-bit floor for unguessable tokens. 256 bits
  clears it and matches the verification/reset token convention.
- **Stored plaintext at rest — on purpose.** Session/reset tokens are
  SHA-256-hashed at rest because a DB leak of those = account takeover at scale.
  This token is different: the data it protects (customer email/name/phone,
  delivery address) lives in plaintext in the *same* `orders` row. An attacker
  who can read `guest_track_token` can already read the PII directly, so hashing
  the token defends against nothing — while costing the ability to re-embed the
  durable link in later status-update emails (we'd have no way to recover the
  raw value). The token's sole job is to be unguessable from *outside* the
  database, which 256 CSPRNG bits achieve. Leak mitigations that *do* matter for
  capability URLs are applied instead: the API never logs the token (it logs the
  order id/number); the `/track` page is served `robots: noindex` +
  `Referrer-Policy: no-referrer`; find-my-order is rate-limited (3/h/IP) and
  enumeration-resistant; unknown/malformed tokens return a uniform 404. No
  migration was needed — the `orders.guest_track_token` column + its UNIQUE
  index already existed (it was populated-but-unused before this slice).

The paired customer/guest **cancellation** rule (`processing` only, stricter
than the admin FSM which can also cancel `ready_for_pickup`) lives in
`lib/order-cancellation.ts` and is shared by `POST /orders/:n/cancel` (account)
and `POST /track/:token/cancel` (guest); both re-read the row `FOR UPDATE` so a
racing admin transition wins and the stale cancel returns 422.

### 13.x Crawlability — serve 301s on the would-be-404 path, not in the proxy

The category cascade-delete has always *written* `redirects` rows (one per
removed category/product URL → nearest surviving ancestor, or home), but nothing
*served* them, so deleted URLs returned 404 and leaked SEO link equity. The
serving design (2026-06-16):

- **Resolve on the would-be-404 path, in the storefront catch-all — NOT in the
  Next.js proxy.** The original schema comment imagined the proxy reading
  redirects "on every request (with caching)". But the proxy is deliberately
  *thin* (§5.2): it runs on every navigation including prefetches and must never
  call the API/DB. Every redirect source is a `/products/*` URL, so the
  `/products/[...path]` catch-all is the complete serving point — and it only
  consults `GET /redirects/resolve` when a path matches no live category/product,
  i.e. on the rare would-be-404. The happy path pays nothing.
- **Transitive chain resolution, server-side.** A later delete of a redirect's
  target turns `A → B` into `A → B → home`. Google follows ≤ 5 hops and
  recommends ≤ 2, so `lib/redirect-resolve.ts` (a pure, injectable-lookup
  function — unit-tested with no DB, like `guest-track.ts`) collapses the whole
  chain to one final hop, with a `seen` cycle guard and a hop cap. A degenerate
  self-redirect resolves to "no redirect" → a real 404.
- **301 vs 308.** Rows store 301; the storefront serves it with Next.js
  `permanentRedirect()`, which emits **308**. Google treats 301 and 308
  identically for indexing/PageRank, and 308 matches the bare-slug
  canonicalisation the catch-all already does — so it's consistent and
  penalty-free. 302/307 ("short-term move") are wired through for completeness
  but the delete writer never emits them. No migration — the `redirects` table
  already existed.
- **Spec's moved-resource toast via a URL fragment.** `docs/README.md`
  §"Пренасочване при изтрит ресурс" wants an unobtrusive notice after the 301.
  The redirect appends a `#moved` **fragment** (not a `?query=` param like the
  account pages' `?confirm=1`): a fragment is never sent to the server and is
  ignored by crawlers, so the indexable 301 target stays canonically clean while
  `components/layout/MovedNotice` (a `useSyncExternalStore` client component in
  the shop layout) still shows the toast and strips the fragment on view.

### 13.x Sitemap `lastmod` from the DB; robots "block-training, allow-search" AI policy

- **Sitemap built server-side for accurate `lastmod`.** `lastmod` is the only
  sitemap field search engines meaningfully weight — and Google *ignores it
  site-wide* once it looks fabricated. The `/products` list DTO doesn't expose
  `updated_at`, so a dedicated `GET /sitemap` projects every live category +
  product to its canonical path + real `updated_at`, using the SAME
  `category-tree.ts` URL helpers the storefront serves with (no drift). The
  storefront `app/sitemap.ts` just prefixes the origin and degrades to
  static-only if the API is briefly unreachable. A single file is correct under
  the 50K-URL cap (this catalog is far below the §16.3 20K-SKU threshold); the
  documented trigger to shard via `generateSitemaps()` is crossing 50K.
- **robots.txt AI-crawler policy.** The 2026 e-commerce consensus is to block
  training/bulk crawlers (GPTBot, CCBot, ClaudeBot, Google-Extended, Bytespider,
  Meta-ExternalAgent, …) while allowing search/retrieval bots (Googlebot,
  Bingbot, OAI-SearchBot, PerplexityBot, ChatGPT-User, …) so the shop stays
  visible in AI answers (with citations → referral traffic) without feeding model
  training. For a per-invocation serverless shop this is also a cost control —
  training bots send almost no referrals (GPTBot ≈ 1,255:1, ClaudeBot ≈
  20,583:1 crawl-to-refer) while costing real Lambda + bandwidth. robots.txt is a
  request, not a fence; WAF rate-limiting (opt-in) is the enforcement layer. The
  policy is one editable list, and non-production hosts return a blanket
  `Disallow: /`.

### 13.x Rate limiting is distributed (Postgres), not in-memory — and not DynamoDB/Redis

- **The defect this fixes.** The public guest surface caps abuse per IP — the
  spec-§7 lost-link resend at 3/hour and anonymous order placement at 30/hour.
  The first implementation kept those counters in a per-process `Map`. On Lambda
  that is per-**container** state: with N warm containers the effective ceiling
  is N × limit, and every cold start wipes the window. So the hard guarantee the
  product copy asserts ("максимум 3 заявки на час от един IP адрес") silently did
  **not** hold in the target deployment. The rest of the codebase already counted
  in shared state — the login lockout reads `login_attempts`, forgot-password /
  resend / email-change count token rows — so the in-memory guest limiter was the
  one place that regressed the standard. This slice brings it back in line.
- **Postgres, because it is the state every container already shares.** The
  counter lives in `rate_limit_counters` (composite PK `(bucket, subject,
  window_start)`, an `integer` count). This is the same "the database marker *is*
  the coordination primitive" stance as the scheduler claim markers and the
  DB-backed lockout — **no new infrastructure, no new trust surface**. DynamoDB
  was rejected for the same reason the scheduler jobs rejected it (we keep one
  datastore; an atomic-counter table in Dynamo would be a second one with its own
  IAM, capacity model, and failure semantics). Redis/Upstash was rejected because
  it adds a network dependency and a long-lived credential for what is a
  low-traffic abuse dampener — the exact "is this complexity justified?" test from
  §14 that the project applies to every dependency.
- **Atomicity with no advisory lock.** One statement does check-and-count:
  `INSERT … VALUES (…, 1) ON CONFLICT (pk) DO UPDATE SET count = count + 1 WHERE
  count < <limit> RETURNING count`. Postgres locks the conflicting row and
  re-reads its latest committed version before applying the UPDATE, so concurrent
  writers serialise on the row lock with **no lost increments** — verified with a
  50-parallel-hit test that admits exactly the limit. This is deliberately
  simpler than the common `pg_advisory_xact_lock` recipe (e.g. Neon's how-to),
  which needs the lock only because it reads the count in a *second* statement;
  `RETURNING` collapses that to one round-trip. The `WHERE count < limit` guard
  means an already-blocked caller is **not** re-incremented (a flood can't grow
  the row unboundedly, and a blocked hit costs no extra write): when the guard
  fails the statement returns zero rows, and that empty result *is* the "blocked"
  signal.
- **Fixed (tumbling) window, computed app-side.** `window_start = floor(now /
  windowMs) * windowMs`, stored as part of the PK, so a new window is just a new
  row that starts again at 1 — no reset/CASE logic. The accepted trade-off is
  fixed-window boundary amplification (up to ~2× across the instant a window
  rolls); that is fine for an abuse dampener (it matches the semantics the
  in-memory limiter already had) and never weakens enumeration resistance, which
  comes from the uniform response, not this counter. The clock is injectable, so
  window behaviour is unit-tested deterministically.
- **Fail-open.** A limiter fault must not take down a public endpoint, and this
  counter is a dampener, not a security boundary — the 256-bit tracking token is.
  A DB error in the limiter is logged and allows the request.
- **Two limiters stay in-memory, by explicit decision.** *csp-report* (60/min/IP)
  is fail-open noise control on a fire-hose endpoint; a per-report DB write would
  itself be a write-amplification DoS vector, so the bounded in-memory bucket is
  the correct design there. *data-export* (5/hour/user) sits behind a **mandatory
  password re-auth** — the re-auth is the real, already-distributed control, and
  the counter is a best-effort secondary email-bomb brake. Both are documented
  here rather than silently left as the kind of per-container limiter this slice
  set out to remove; promoting either to the DB limiter is a one-line change if a
  reason ever appears.
- **Retention.** Past windows are never read again, so the daily
  `unverified-cleanup` sweep drops `rate_limit_counters` rows older than 2 days
  (the longest window is 1 hour) — the table's only janitor, same idempotent-sweep
  model as the `login_attempts` prune, no dedicated cron.

### 13.x Framework-level errors map to their true HTTP status, never a blanket 500

- **The defect this fixes.** The global `onError` (`app.ts`) mapped our own
  `ApiError` and Zod's `ZodError` to RFC 9457 Problem responses, then treated
  every *other* throw as a 500. But the framework itself throws typed errors that
  already carry a status — above all the `HTTPException(400, "Malformed JSON in
  request body")` Hono's request-body validator raises when `JSON.parse` fails.
  That parse runs *before* the Zod `defaultHook`, so the throw is neither an
  `ApiError` nor a `ZodError`; it fell through to the 500 branch. A client posting
  an unparseable body was told the **server** had failed.
- **Why 400, not 500 (the standard).** RFC 9110 §15.6 frames a 5xx as "the server
  failed; an identical retry may succeed" — false for malformed JSON, where the
  retry *must* change. Every 2026 reference (RFC 9457, the OWASP error-handling
  guidance, Spring/ASP.NET) puts an unparseable body at **400** (a syntax error),
  distinct from **422** for a parseable-but-semantically-invalid one. We keep
  schema-validation failures at **400** as well (not 422): 422 is optional under
  RFC 9110, and splitting it out would be a breaking contract change across every
  endpoint and its tests for no functional gain. The only new behaviour is that a
  *parse* failure is now a first-class `400 /problems/malformed-json` rather than
  a 500.
- **Why it also matters for the SLO, not just the client.** The availability SLI
  counts `status >= 500` on the `request_end` log line (§8.5, items 24/25) and —
  unlike the legacy AWS `Errors` alarm — it *sees* the graceful 500s `onError`
  returns. So every malformed-body request was silently burning the **server**
  error budget on a **client** mistake — exactly the 4xx-vs-5xx confusion the
  Google SRE Workbook warns against. Mapping the parse error to 400 keeps client
  faults out of the budget.
- **Implementation.** Classification is a pure `frameworkProblem(err)`
  (`lib/error-response.ts`): a Hono `HTTPException` (explicitly excluding our own
  `ApiError`, which `onError` maps first) is honoured at its real status — the
  malformed-JSON message becomes `/problems/malformed-json`, any other becomes
  `about:blank` with the RFC 9110 reason phrase as `title` (an `HTTPException`'s
  message can be empty); a raw `SyntaxError` (the native `Request.json()` path —
  no route uses it today) degrades to the same 400 as defence-in-depth. Anything
  else returns `null`, so the existing 500 path is untouched and a genuine server
  fault is never masked. The offending body is never reflected back in `detail`
  (it can carry PII). Pure + DB-free, so the whole decision table is unit-tested
  without booting the app — the same convention as the rest of `lib/*.ts`.

### 13.x Admin product CRUD — single-SKU, uniqueness across archived rows, image-by-key

- **Single-SKU, no variant matrix (researched).** Each product carries one
  `code` (SKU); there is no `product_variants` child table. The 2026 guidance is
  unambiguous for a small catalog — "when a product has no variations, SKU and
  product are one and the same, and the data model is extremely simple." A
  variant/option matrix is a real cost (two-level ID resolution, a combinatorial
  SKU table, variant-aware cart/checkout/search) that earns its keep only past a
  genuine size/colour requirement. So variants are a deliberate §16 door, opened
  on demand — the same posture as the search-infra and multi-tenant doors, not a
  silent omission.
- **Uniqueness checks deliberately span soft-deleted rows.** `products_slug_unique`
  and `products_code_unique` are non-partial indexes, so an archived product still
  holds its slug and SKU. The create/edit pre-checks therefore query ALL rows (not
  just live ones): a collision returns a clean `409`
  (`/problems/product-slug-conflict` / `…-code-conflict`) instead of letting the DB
  constraint surface as a 500, and it is the correct behaviour anyway — a
  soft-deleted slug still 301s away (SEO), and a SKU is a stable identifier. To
  reuse an archived product's slug/SKU you restore it, not recreate it.
- **Category parity for the lifecycle.** Optimistic locking is `updatedAt` +
  `SELECT … FOR UPDATE` + a millisecond compare (no `version` column, no migration
  — identical to the categories slice and for the same reasons). Soft-delete writes
  a 301 `redirects` row from the product's canonical URL to its surviving category
  (or home), mirroring the category cascade so a removed product URL 301s rather
  than soft-404s; restore clears that redirect and re-homes an orphan (whose
  category was cascade-deleted) to uncategorised so a live product never dangles
  under a dead category. Every state change appends an `admin_audit_log` row.
- **Images stored as S3 keys; the upload pipeline is a separate, infra-bearing
  slice.** Create/PATCH accept an ordered image list of `{ s3Key, altText }` and
  the public URL is derived at the edge by `buildImageUrl` — exactly the existing
  categories/banners convention. No entity has an actual file-upload path yet. The
  2026-correct one (researched) is a **presigned direct-to-S3 POST** — the browser
  uploads straight to the bucket, never through Lambda (which has a 6 MB sync
  payload cap and would pay for the bytes) — with the POST policy pinning a
  content-type allowlist, a `content-length-range`, and a key prefix, plus a
  `PutObject`-triggered Lambda that re-checks the real MIME by magic bytes (client
  validation is bypassable), behind the bucket + CloudFront/OAC Terraform. Built
  once it serves products, categories AND banners uniformly, so it is its own slice
  rather than bolted onto this one.
- **Pure helpers.** Slug resolution, image-list normalisation (trim / dedup / cap /
  dense order), the canonical-URL builder for the redirect, and the three-way
  `new_until` resolution live in `lib/product-admin.ts` — DB-free, unit-tested in
  isolation, ready for a future `admin-api` Lambda, same split as
  `lib/category-tree.ts` and `lib/order-status.ts`.

### 13.x Image uploads — presigned POST, direct-to-S3, server-side magic-byte validation

The keystone that activates every image key the catalog already stores
(`product_images.s3_key`, `categories.image_s3_key`, `banner_slides.image_s3_key`).
Built once (`routes/admin/uploads.ts` + `assets/handler.ts` + `lib/asset-upload.ts`
+ `infra/assets.tf`), it serves products, categories AND banners uniformly. All
decisions below were researched against 2026 practice.

- **Presigned POST, not presigned PUT (researched).** Only the POST policy can
  pin BOTH a `content-length-range` and an exact `Content-Type` in the signature,
  so S3 itself refuses an over-cap or wrong-type upload before a byte is stored. A
  presigned PUT can sign a `Content-Type` header but cannot enforce a size bound
  server-side. POST is the AWS-recommended browser-upload primitive for exactly
  this reason.
- **Direct browser→S3, never through Lambda.** The bytes go straight to the
  bucket. Routing an image through the API Lambda would hit the 6 MB synchronous
  payload cap and bill for every uploaded byte of compute time. shop-api only
  *signs* the policy (a few milliseconds, no bytes), so the upload path costs the
  function nothing.
- **The declared Content-Type is never trusted as proof of content.** It scopes
  the presign; it does not prove the file is an image. A `.jpg` can carry an
  HTML/JS polyglot, an SVG (an XML/script vector — deliberately NOT on the
  allowlist), or a renamed executable. So an **`s3:ObjectCreated` validator
  Lambda** (`assets-fn`) reads the object's leading bytes and re-derives the TRUE
  type from its magic number (`lib/asset-upload.ts` — the same allowlist the
  presign uses). Magic numbers can't be forged without corrupting the pixels.
  Client-side validation is convenience only.
- **Two prefixes + promote-or-delete, so hostile content is never servable.**
  Uploads land in `pending/`; the validator **copies** a genuine, allowlisted
  image (whose bytes match its key's extension) to `uploads/` and **deletes**
  everything else. The CloudFront distribution's `origin_path` is `/uploads`, so
  `pending/` is unreachable through the CDN even by exact key — an attacker who
  somehow obtains a presigned POST still cannot leave servable hostile content in
  the bucket. A lifecycle rule expires anything left in `pending/` after a day.
  This event-driven design (over a synchronous "finalize" endpoint that validates
  on demand) was chosen because it guarantees EVERY landed object is validated,
  not only the ones a finalize call happens to reference.
- **Server-generated keys.** The object key is `pending/<kind>/<uuid>.<ext>` with
  a random UUID the server picks — never a client-supplied name. No path
  traversal, no overwrite of an existing image, no key-guessing. The validator
  re-parses the key with a strict regex (kind ∈ the three folders, a real UUID,
  an allowlisted extension) as defence in depth before promoting.
- **CloudFront + OAC over a PRIVATE bucket (researched), not a public bucket and
  not CloudFront signed URLs.** 2026 guidance is unambiguous: never make the
  image bucket public; use Origin Access Control (sigv4, supersedes OAI) with
  `BucketOwnerEnforced` ownership and a full public-access block, so objects are
  reachable only through the distribution. Signed URLs are for *private* assets;
  catalog images are public content, so OAC-alone (no per-object signing) is
  correct — the bucket stays locked down, the images stay cacheable and CDN-fast.
- **The stored key is origin-relative.** Entities store `<kind>/<uuid>.<ext>`
  (no `uploads/` prefix); `CDN_BASE_URL` + the distribution's `origin_path`
  supply the rest. Same reason `images.ts` never stored a fully-qualified URL: the
  serving origin (CloudFront today, Cloudflare R2 tomorrow — §10) can change
  without rewriting a single row.
- **Rejected / deferred.** Presigned PUT (no size enforcement); a synchronous
  finalize-endpoint validator (misses objects never finalized); a public bucket
  (the classic S3 image-leak); **Sharp transcoding + EXIF stripping at upload**
  (a real enhancement — §3.6 — but it adds a native arch-matched Lambda binary
  and earns its keep only past a performance or third-party-PII-in-metadata need;
  uploads are admin-only today, so that need is not yet present). Pure helpers
  (allowlist, key layout, request validation, the magic-byte sniffer) live in
  `lib/asset-upload.ts`, DB- and AWS-free, unit-tested in isolation — the same
  split as `lib/category-tree.ts` / `lib/product-admin.ts`, and the single source
  of truth both the presign route and the validator Lambda import so the contract
  can never drift.
- **Live-validated end-to-end 2026-06-27 — three latent deploy bugs fixed (do NOT
  regress).** The pipeline shipped 2026-06-22 but had never actually moved a byte
  through to the CDN until the products-admin frontend exercised it on a real
  stack. Three independent things must hold, each now in code:
  1. **The validator must be DB-free.** `assets-fn` has no `DATABASE_URL`
     (correct — it never queries), yet it imported the shared `logger`, which
     eagerly ran `parseEnv()` whose schema *requires* `DATABASE_URL` → the Lambda
     threw on cold start and promoted nothing (every object stuck in `pending/`).
     `lib/logger.ts` now reads `LOG_LEVEL` / `NODE_ENV` directly from
     `process.env`, so logging never drags the DB schema into a DB-free bundle.
     The API still fails fast on a bad env at boot via `app.ts`'s `parseEnv()`.
  2. **CloudFront OAC + SSE-KMS needs a KMS *key-policy* grant.** Serving an
     SSE-KMS object means S3 must `kms:Decrypt` on CloudFront's behalf, and the
     CloudFront SERVICE principal can only be granted that in the key policy (IAM
     cannot grant a service principal). Missing it → every image 403s at the edge
     even though upload + validation + promotion all succeeded. `kms.tf` now
     grants `cloudfront.amazonaws.com` `kms:Decrypt`, `AWS:SourceArn`-scoped to
     this account's distributions (account-wildcard to avoid a TF cycle, since the
     bucket SSE already depends on the key).
  3. **The browser's own CSP must allow the upload + the render.** The strict CSP
     in `frontend/src/proxy.ts` gained the S3 bucket origin in `connect-src` (the
     direct POST) and the assets CDN in `img-src` (the rendered image), both
     env-driven (`NEXT_PUBLIC_ASSET_S3_ORIGIN` / `NEXT_PUBLIC_ASSET_CDN_ORIGIN`).
     And `asset_cors_allowed_origins` (the S3 bucket CORS) is the BROWSER PAGE
     origin the admin UI is served from — never the CDN's own domain.

  The `ImageUploadField` widget also now confirms promotion (`waitUntilReady`)
  before saving a key, so a rejected upload (e.g. a `.jpg` that isn't really a
  JPEG — the validator deletes it) surfaces immediately instead of becoming a
  silent broken image on the entity.

### 13.x Banners — internal-link-only, hard delete, accessible auto-rotation (item 47)

The homepage hero (spec §"Управление на банер") activates the dormant
`banner_slides` table. Decisions, each researched against 2026 practice:

- **The click-through link is validated to a same-origin path, server-side.** A
  banner's `linkUrl` is admin-entered and is rendered into an `<a href>`. The
  pure `lib/banner.ts` accepts ONLY a path-absolute internal link (`/products/…`)
  and rejects absolute, protocol-relative (`//evil`, the `/\evil` backslash
  variant), and scheme (`javascript:`/`data:`) URLs. That keeps a promo pointing
  at the shop's own catalogue (what the spec intends), and structurally
  forecloses both the open-redirect and the href-injection XSS class — validated
  once, at write time, so the frontend binds the value without a second
  sanitiser. (Distinct from the image bytes, which still go through the
  presigned-POST + magic-byte validator pipeline, item 46.)
- **Hard delete, not soft.** Categories and products soft-delete because they own
  order-history references and live URLs that must 301. A banner owns neither —
  it is pure presentation — and the `isActive` toggle already provides
  hide-without-delete (the spec's „Активиране / Деактивиране … без изтриване").
  So DELETE removes the row; the `admin_audit_log` entry preserves what was
  removed for the GDPR Art. 30 record. Same optimistic-lock (`updatedAt` +
  `SELECT … FOR UPDATE`) and audit posture as the other admin slices.
- **The widget proves its reuse claim.** `ImageUploadField` was built (item 46)
  to serve products / categories / banners by a `kind` prop. The banner editor
  consumes it unchanged with `kind="banners"` + `max=1` — the first confirmation
  that the "build once" promise holds, and the template for the category editor.
- **WCAG 2.2.2 (Pause, Stop, Hide) is non-negotiable for an auto-rotating hero.**
  The carousel cycles every 5s, which is auto-updating content lasting >5s in
  parallel with other content — a Level A requirement (binding under the EAA /
  EN 301 549 conformance this project already claims, §15 item 40). The
  `BannerSlider` therefore ships a visible pause/play control, pauses on
  hover/focus, and never auto-rotates under `prefers-reduced-motion`; the live
  region is `aria-live="off"` while rotating (no 5-second chatter) and `polite`
  once stopped. Performance rides along: the hero is the page's LCP element, so
  its image is `fetchPriority="high"` and eager (never lazy) per 2026
  Core-Web-Vitals guidance, with the aspect-ratio box reserving space for CLS.
- **Kept spec-minimal.** No scheduling windows, no per-slide CTA label column
  (the schema models exactly the spec's fields: image, title, subtitle, link,
  active) — a generic „Разгледай" CTA is defaulted when a link is present. The
  key layout already accommodates richer banners without a migration if needed.

### 13.x Store settings — DB-backed config, typed registry, document-level lock (item 48)

The admin "Настройки" screen (spec §"Настройки на магазина") activates the
dormant key-value `settings` table. Decisions, each researched against 2026
practice:

- **Operator-editable business config lives in the DB, not environment
  variables.** The Twelve-Factor "config in the environment" rule is scoped to
  *what varies between deploys* plus *secrets*. The shop's phone, address,
  opening hours, default pickup window, and admin-notification recipient are none
  of those — they are *runtime application data* the single admin edits from the
  panel, and changing an env var requires a redeploy/rebuild (an industry-wide
  property, e.g. Azure App Service docs). So those values move into the `settings`
  table; **secrets stay in env/SSM** (DATABASE_URL, the KMS/MFA keys, queue URLs).
  `SHOP_CONTACT_PHONE` is demoted to a fallback the guest-tracking contact block
  reads only when the `store_phone` setting is blank. This is the slice that
  retires the "migrate this to the settings table when it lands" TODO the env
  schema carried.
- **A typed registry is the single source of truth.** `lib/settings.ts` (pure,
  unit-tested) defines, per key, a Zod schema + default + a `public`/`private`
  visibility flag. Writes are validated + normalised against it (trim, control-
  character strip via a code-point scan, length cap, permissive phone, email-or-
  empty); unknown keys are rejected by a strict allow-list. This is the *write*
  half of OWASP "validate input, encode output" — the *read* half is React's
  auto-escaping under the storefront's strict nonce CSP, so an operator-entered
  value is never interpreted as HTML and the stored-XSS surface is closed without
  ever treating settings as markup.
- **Public read is partitioned and edge-cached.** `GET /settings` exposes ONLY
  the four customer-facing keys (address, hours, phone, email) as a camelCase
  DTO, with the same ETag + `s-maxage=300` policy as `/banners`/`/categories`
  (the codebase's proven serverless-caching answer — no bespoke cache layer). The
  two operational keys never reach an anonymous response.
- **Document-level optimistic lock, no `version` column.** A key-value document
  has no single `updatedAt`, so the lock token is `MAX(updated_at)` across the
  rows (ISO). `PATCH` re-reads the rows `FOR UPDATE`, recomputes the max, and
  compares in JS at millisecond precision (sidestepping the Postgres-microsecond
  vs JS-millisecond equality pitfall, exactly as the banner slice) → `409
  /problems/settings-version-conflict` on a stale second tab. Only the changed
  keys are written; each save appends one `admin_audit_log` row (GDPR Art. 30).
  Same requireAdmin→404 + audit posture as the other admin slices; no migration
  (the table was modelled in migration 0000).

### 13.x Account management — per-account discount, PII read-logging, erasure reuse (item 49)

The admin "Управление на акаунти" screen (spec §10 + §11 „Отстъпки") activates the
**write** side of the `discounts` table. Decisions, each researched against 2026
practice:

- **The discount book is a governed, auditable artefact, not a free field.**
  Checkout has read `discounts.percent` (a per-account percentage applied to the
  whole basket, integer-cent floor) since the first orders slice — but no route
  could ever *write* it: a B2B customer's contracted rate could only be granted by
  a raw `INSERT INTO discounts` in psql. This slice is that table's first writer,
  the same "retire the manual SQL" driver behind every prior admin slice. The
  model is deliberately the simplest correct one for the tier: a single percentage
  per account (the `discounts` PK is `user_id` → the spec's „само една активна
  отстъпка"), `applied_by`/`applied_at` recorded and surfaced. This is the standard
  B2B *account-level / customer-group* pricing shape; **product-level** discounts
  (a cut visible to everyone) are a documented door (spec §11 „Бъдещо развитие",
  §16), opened only on demand — the `order_items.discount_amount_cents` column
  already exists for a future per-line coupon.
- **Optimistic lock on `applied_at`, no `version`/`updatedAt` column.** Same
  discipline as banners/products, but the token is the discount row's `applied_at`
  (the only timestamp it has). SET locks the customer row `FOR UPDATE`, re-reads
  the discount row, and compares at millisecond precision → `409
  /problems/customer-discount-conflict`. A fresh grant sends `expectedAppliedAt =
  null` and conflicts if a discount appeared meanwhile. Because `applied_at`
  defaults to the DB `now()` (µs), it is set explicitly to a JS `Date` (ms) on
  every write so the token round-trips cleanly — the same µs-vs-ms pitfall the
  other slices dodge.
- **Admin PII *reads* are logged, not only writes.** 2026 insider-risk / GDPR
  data-minimisation guidance is to record administrative *access* to customer PII,
  not just state changes. The detail view (which exposes name, phone, company data
  and order history) emits a structured `admin_customer_viewed` Pino event
  (actor + subject id, **no PII in the line**). It deliberately does NOT write to
  `admin_audit_log`, whose documented contract is state-*changing* actions — a read
  is not one. Secrets (password hash, MFA secret, tokens, raw login telemetry) are
  never selected into the DTO in the first place (data minimisation at the query).
- **Deletion reuses the GDPR Art. 17 erasure library, not a parallel path.**
  `DELETE /admin/customers/:id` runs the spec §10 active-order guard
  (`findActiveOrdersForUser` → `422` with the blocking order numbers, byte-identical
  to the customer's own `DELETE /auth/me`) then the SAME `executeAccountDeletion`
  transaction (pseudonymise the users row + order PII under the Bulgarian 10-year
  accounting-retention exemption, hard-delete profile/cart/addresses/discount/
  tokens). One erasure implementation, two entry points — the admin's AAL2 authority
  stands in for the customer's password re-auth (the operator acts on an
  out-of-band erasure request or removes a defunct account). Best-effort
  `account-deleted` notice to the original address; a `customer.delete`
  `admin_audit_log` row for the Art. 30 trail.
- **Storefront discount visualisation: cart + checkout done; anonymous catalog
  deferred.** The spec §11 wants the discounted customer to see the reduced price
  wherever a price appears. The *authenticated, dynamic* surfaces now show it: the
  server cart view (`routes/cart.ts` `readCart`) returns the customer's
  `discountPercent` alongside the subtotal, and the cart drawer + both checkout
  steps render the „Отстъпка (N%)" line and the discounted „Общо" — computed with
  the **same integer-cent `Math.floor`** the order endpoint uses, so the summary
  equals what will be charged (no second pricing source; the discount travels with
  the cart, so it is auth-scoped and refreshed on every cart read — guests always
  get 0). What remains deferred is only the **anonymous catalog** strike-through
  (product card, product page): those endpoints (`/products`, `/categories`) are
  anonymous and edge-cached (`s-maxage=300`), so per-user pricing cannot ride the
  cached response without either a personalised (uncacheable) catalog tier or a
  client-side price-adjust pass keyed on the logged-in discount — a scoped
  follow-up, noted so the remaining gap is explicit, not accidental. Same
  requireAdmin→404 posture on the write side; no migration.

### 13.x Admin dashboard — on-the-fly aggregates, realised-sales definition, accessible trend (item 50)

The `/admin` landing screen (spec §"Табло") was the last high-traffic admin page
still rendering fabricated numbers off `frontend/src/lib/mock-data/*`. It is now a
single read-only endpoint, `GET /admin/dashboard`. Decisions, each researched
against 2026 practice:

- **On-the-fly aggregation, not a materialised view — with a documented trigger.**
  The 2026 guidance on dashboard query patterns is to compute aggregates at read
  time while the query is cheap and the data must be live, and to promote to a
  scheduled materialised view / summary table only when the query becomes expensive
  *and* the operator will tolerate refresh-interval staleness. At this shop's tier
  (0–500 orders/mo, §16.1) every figure is an indexed single-digit-ms scan
  (`count(*) FILTER (…)` / `sum(…) FILTER (…)` over `orders_created_at_idx`,
  `orders_status_idx`, `products_stock_status_idx`, `users_role_idx`), the seven
  aggregates run concurrently, and an operator who just accepted an order expects
  the count to move *now* — so read-time aggregation is correct. The migration
  trigger is recorded like the §16.3 search threshold: **when dashboard p95 latency
  becomes material (roughly Tier 3+), move the daily-trend + monthly rollups to a
  summary table refreshed by the existing scheduler-fn, or a `REFRESH MATERIALIZED
  VIEW CONCURRENTLY` cron.** The schema even anticipated this slice — the composite
  `orders_status_created_at_idx` is annotated "for the admin dashboard query".
- **Honest metric selection.** The mainstream ecommerce-KPI canon leads with
  conversion rate, sessions/traffic, LTV and CAC — all of which need web-analytics
  this cash-on-delivery / pay-at-store shop deliberately does not collect. Rather
  than fabricate them, the dashboard reports only what the database actually knows:
  realised sales (orders + revenue), **average order value** (the one "Big Five" KPI
  that *is* computable here, = revenue ÷ orders), new registrations, the operational
  action queue, and the trend. Traffic-derived KPIs are a deliberate future door
  (they arrive with a RUM/analytics pipeline, §15 item 29), not a blank tile.
- **Realised-sales definition, kept coherent.** The sales trio — orders, revenue,
  AOV, for the month, for today, and per day on the trend — counts only orders whose
  status is **NOT `cancelled` and NOT `returned`**: a cancelled order is not a sale
  and a returned one was reversed. Because the revenue sum and the order count are
  taken over the *same* population, AOV = revenue ÷ orders is a true per-order
  average, not a ratio of two different sets (the classic dashboard bug). The
  `recentOrders` feed is the deliberate exception — it shows every status because it
  is an activity log, not a sales figure. Money is integer cents throughout;
  `numeric` sums arrive as strings and are `Number()`-cast once.
- **Europe/Sofia period bounds, in SQL.** "This month" and "today" are Bulgarian
  calendar boundaries — a 01:00 EET order belongs to the day it was placed. The
  bounds are `date_trunc('month', now() AT TIME ZONE 'Europe/Sofia') AT TIME ZONE
  'Europe/Sofia'` (and the `::date` equivalent for today / the 14-day window start),
  which land as `timestamptz` instants the planner range-scans on `created_at`, and
  are DST-correct — the same idiom the admin-orders date filter and the order-number
  sequence already use. The 14-day trend groups on `(created_at AT TIME ZONE
  'Europe/Sofia')::date`; the sparse per-day rows are zero-filled into a dense
  14-point axis by a pure, unit-tested helper (`lib/dashboard-metrics.ts`) whose
  calendar arithmetic runs on a noon-UTC anchor so day subtraction can never roll a
  boundary.
- **The trend is accessible by construction.** Per WCAG 1.1.1 / 1.4.1, the 14-day
  chart is an SVG `role="img"` with a descriptive label AND a visually-hidden data
  table carrying the identical numbers — the recommended "chart + tabular
  alternative" pattern — so the trend is fully available to screen readers and never
  conveyed by colour alone (bar colour is the accessible `--primary-strong` token via
  `currentColor`; per-bar `<title>` gives sighted-hover detail). The component lives
  under `components/admin/**`, so it clears the full jsx-a11y bar, not the relaxed
  `app/admin/**` subset.
- **A read is logged as a read.** The recent-orders feed surfaces customer names, so
  — consistent with item 49 — viewing the dashboard emits an `admin_dashboard_viewed`
  Pino event (actor id only, no PII in the line). It writes no `admin_audit_log` row:
  that table's contract is state-*changing* actions, and a dashboard read changes
  nothing. requireAdmin→404 like the rest of the surface; no migration.
- **Relationship to spec §"Начален екран" — a documented, partly-forced superset.**
  The spec sketches four *activity-count* cards (нови поръчки, активни поръчки,
  изтекли срокове, изчерпани продукти) plus three „Бързи действия" buttons. The
  shipped dashboard keeps the spec's operational signals — **нови поръчки, изтекли
  срокове, and изчерпани продукти live in the action queue** — and deliberately adds
  the money view the spec omits but an operator actually runs the business on
  (realised revenue, AOV, the 14-day trend, recent orders, new customers). Two
  alignment gaps are recorded, not accidental: the **„Активни поръчки"** count
  (shipped + ready_for_pickup) is not yet its own tile (cheap to add), and of the
  three **„Бързи действия"** buttons „Ръчно архивиране" (manual catalog backup)
  shipped with the archive slice (item 51, 2026-07-07) and „Нов продукт" is a link
  away — only „Наредба на съдържанието" (the combined category+product ordering view)
  still depends on an unbuilt feature. Tightening this alignment is a scoped
  follow-up, not a blocker: the page is real, tested, and strictly better than the
  mock it replaced.

### 13.x Admin archive — trash-restore + on-demand backup, destructive restore deferred (item 51)

The archive screen (spec §12) is the last admin page to go real (2026-07-07). Two
decisions shaped the slice.

- **Two recovery mechanisms, honestly separated.** 2026 "trash + backups" guidance
  treats *soft-delete restore* and *point-in-time snapshot restore* as distinct
  tools. This page shows both — the `deleted_at` products/categories awaiting an
  explicit per-item restore, and the `catalog_backups` snapshots the scheduler
  writes — but implements only the safe, reversible per-item restore now. **Restore
  a whole snapshot over the live catalog is deferred (item 52)**: overwriting live
  rows is high-blast-radius and wants a diff/preview + confirm + a single
  transactional replay, which is its own slice. Shipping the 80% (recover an
  accidentally-deleted item) and documenting the risky 20% is the same disciplined
  scoping the dashboard slice used for its quick-actions.
- **Restore lives with its entity; the missing half was categories.** Per-item
  restore is served by each entity's own route (`POST /admin/products/:id/restore`
  already existed), so the archive UI just calls them — no second writer of those
  tables. This exposed a real gap: there was **no** category restore, so a
  cascade-soft-deleted category was unrecoverable via the API (its slug may have been
  reused by a new live category, since category slug-uniqueness is scoped to live
  rows — "recreate" is not a restore). The new `POST /admin/categories/:id/restore`
  mirrors product-restore exactly: FOR-UPDATE lock, un-archive, clear the 301 at the
  restored canonical path, re-home an orphan to root when its parent is still gone,
  and a clean `409 /problems/category-restore-conflict` when a live sibling now holds
  the slug (rather than a broken tree or a DB-constraint 500).
- **On-demand backup reuses the scheduled job.** `POST /admin/archive/backup` (the
  spec's one-button „Ръчно архивиране") is the daily catalog-backup job in a `manual`
  mode: a timestamped key under `catalog/manual/` (so each click is a distinct
  restore point that never clobbers the day's scheduled snapshot) and an always-INSERT
  `kind='manual'` row (vs the scheduled replace-by-key). It is gated behind the backup
  bucket — a clean `503 /problems/backups-not-configured` until set, and shop-api's
  exec role is granted `s3:PutObject` on that bucket behind `enable_scheduler` (the
  flag that provisions it). The S3 write is injectable, so the route is fully tested
  without AWS; a manual backup is a state change, so it writes an `admin_audit_log`
  `backup.create` row (the overview read, carrying no PII, is a plain info log).

## 14. Honest assessment vs A+ target

**Current state, scored against AWS Well-Architected:**

| Pillar | Today | What's missing for A+ |
|---|---|---|
| Operational Excellence | B+ | Production deploy, DORA metrics, scheduled DR drills, status page (distributed tracing ✅ item 18, 2026-06-13; formal SLOs-as-code + multi-window burn-rate alerting ✅ items 24/25, 2026-06-14 — `infra/slos.yaml` + `infra/slo.tf`, awaiting live traffic to exercise; incident-response playbook + blameless-postmortem template ✅ item 31, 2026-06-15 — `docs/INCIDENT-RESPONSE.md`) |
| Security | A | Customer MFA option (growth-stage); admin auth ✅ (TOTP MFA shipped end-to-end 2026-06-08 — backend + sign-in UI) |
| Reliability | B | Production deploy, DR drill cadence, public status page (SQS email retry queue ✅ 2026-06-12 — live-validated incl. the DLQ → alarm → redrive drill; scheduler-fn + daily catalog backup + retention sweeps ✅ 2026-06-12, live-validated 2026-06-13 — the manual drills for all three jobs passed against Neon; the first drill exposed that the prod `neon-http` driver cannot run `db.transaction(...)`, fixed by switching to the Neon serverless WebSocket driver) |
| Performance Efficiency | B+ | Synthetic monitoring, RUM, query-latency SLOs per endpoint |
| Cost Optimization | B− | Cloudflare swap (the big one), CloudWatch retention to 14d |
| Sustainability | A | Documented quarterly AWS CFT review |

The Security A grade comes from the code-level posture (Argon2id,
constant-time login, strict CSP, HIBP, SLSA L2, SBOM signing, RFC
9116 disclosure, GDPR Art. 16 + 17 self-service, and — since
2026-06-08 — admin TOTP MFA at AAL2 with replay-guarded codes and a
secret encrypted at rest). The B / B+ grades on
Reliability and Operational Excellence reflect the absence of a
durably-running production environment: the IaC is live-apply-validated
(item 17) and SLOs-as-code + burn-rate alerting now ship (items 24/25), but
scheduled DR drills, a status page, and live traffic to exercise the SLOs
still need a maintained deployment.

**Cross-checked against 2026 industry standards beyond AWS WA:**

| Standard | Status | What's needed |
|---|---|---|
| NIST CSF 2.0 (Govern function) | ✅ Met | — |
| NIST CSF 2.0 (Detect function) | ✅ Met | Distributed tracing shipped (OpenTelemetry, item 18, 2026-06-13) |
| NIST CSF 2.0 (Respond function) | ✅ Met | Incident-response playbook shipped 2026-06-15 (item 31, `docs/INCIDENT-RESPONSE.md`) — RS.MA/AN/CO |
| OWASP Top 10 2025 — A03 Supply Chain | ✅ Met | — |
| OWASP Top 10 2025 — A08 Integrity Failures | ✅ Met | — |
| OWASP Top 10 2025 — A02 Security Misconfiguration | ✅ Met | — |
| OWASP Top 10 2025 — A09 Logging Failures | ✅ Met | CSP reporting + distributed tracing (item 18, 2026-06-13) |
| OWASP ASVS 6.0 L1 | ✅ Compliant | — |
| OWASP ASVS 6.0 V6.2 (password lifecycle) | ✅ Met | — |
| OWASP ASVS 6.0 V6 (multifactor) — admin | ✅ Met | Mandatory TOTP MFA on `/admin/auth/*` (2026-06-08) |
| OWASP ASVS 6.0 L2 | ⚠️ Gaps | Customer MFA (admin MFA ✅; customer MFA growth-stage) |
| NIST SP 800-63B-4 | ✅ Met | — |
| NIST SP 800-63B-4 AAL2 (admin) | ✅ Met | Password + TOTP; single-use look-up secrets (recovery codes) |
| NIST SP 800-207 (Zero Trust) | ✅ Spirit | — |
| SLSA v1.1 | ✅ Level 2 | Level 3 only if contractual need |
| CIS Controls v8.1 IG1 | ✅ Met | — |
| GDPR Art. 32 / 16 / 17 | ✅ | — |
| GDPR Art. 15 (right of access) | ✅ | — (`POST /auth/me/export`, May 31 2026) |
| GDPR Art. 20 (data portability) | ✅ | — (same endpoint; structured machine-readable JSON) |
| GDPR Art. 33–34 (72h breach) | ✅ | Documented breach track (`docs/INCIDENT-RESPONSE.md` §6, item 31, 2026-06-15); operational filing depends on the live deploy |
| EU Directive 2023/2673 | ✅ Shipped | — |
| EU CRA (Sep 2026) | N/A | Out of scope (SaaS); CRA-style hygiene voluntarily maintained |
| WCAG 2.2 AA / EN 301 549 / EAA | ✅ | — (2026-06-02; tokens, keyboard/focus/skip-link, reduced-motion, ARIA combobox; static jsx-a11y in CI + runtime axe + `/accessibility` statement) |

**Verdict.** Code-level posture is meaningfully above 2026 industry
median for a B2C shop of this profile. The gap between today and a
production-grade live shop is operational: deploy it, drill it,
instrument it, document the actual running state. Concrete roadmap
in §15.

A side note on the "no compromise" framing: there's no such thing in
software architecture. Every choice trades something. What CAN exist
is "no UNJUSTIFIED compromise" — every trade-off is explicit,
intentional, and documented. The roadmap below gets the project to
that state.

---

## 15. Roadmap to A+

Ranked by `(impact ÷ effort)` — highest leverage first. Items marked
✅ have shipped; items marked ❌ have not and are recommended next.

### Already shipped (Week 1, May 2026)

1. ✅ **CodeQL SAST** — `.github/workflows/codeql.yml`.
2. ✅ **CycloneDX SBOM per workspace** — `.github/workflows/sbom.yml`.
3. ✅ **Sigstore keyless signing** — SLSA Level 2 achieved.
4. ✅ **`.well-known/security.txt`** + bilingual `/security` policy
   page.
5. ✅ **Uniform strict CSP** with nonce + strict-dynamic + reporting.
6. ✅ **HIBP k-anonymity** check on register, reset, change-password.
7. ✅ **NIST SP 800-63B-4** length-only password rules.
8. ✅ **Authenticated self-service password change** —
   `POST /auth/change-password`.
9. ✅ **GDPR Art. 16** — `PATCH /auth/me` for profile rectification.
10. ✅ **GDPR Art. 17** — `DELETE /auth/me` for right-to-erasure.
11. ✅ **EU Directive 2023/2673** — 14-day withdrawal flow.
12. ✅ **CSP violation reporting** — `POST /csp-report` (modern +
    legacy formats).
13. ✅ **Order-confirmation email** — `orders.order-confirmation`
    template + `sendOrderConfirmationEmail` helper, wired into
    `POST /orders` after the checkout transaction commits. Best-
    effort: transport failure logs `order_confirmation_email_failed`
    but does not fail the order. Idempotency-replay does NOT re-send.
    Closes the EU 2011/83/EU Art. 8(7) durable-medium-of-contract gap
    that was previously blank.
14. ✅ **Order-status-update email template + wire-up** — `orders.order-status-update`
    template + `sendOrderStatusUpdateEmail` helper. Status-aware copy
    for `accepted` / `ready_for_pickup` / `shipped` / `delivered` /
    `cancelled`. Wired 2026-06-10 into `POST /admin/orders/:n/status`
    (item 22) — fires best-effort after each customer-visible
    transition commits.
15. ✅ **Real storefront browsing** (2026-05-28; JSON-LD + type
    plumbing follow-up 2026-05-29). Home page, `/search`,
    `/products/[...path]`, and the header autocomplete all moved
    off `frontend/src/lib/mock-data/{products,categories}` to real
    `@shop/api` calls. The catch-all
    `/products/[...path]` is now an async Server Component that
    resolves the URL against the live category tree as either
    (a) the virtual `new-products` view, (b) a pure category chain,
    (c) a category chain + product slug, or (d) a bare product slug
    (which 301-redirects to the canonical category-prefixed URL via
    `permanentRedirect`). Product pages emit `Schema.org` `Product`
    + `BreadcrumbList` JSON-LD in an `@graph` envelope, plus
    per-product `generateMetadata` with canonical URL and OpenGraph
    image. Tree-helper module `frontend/src/lib/catalog.ts` exposes
    pure functions over the live tree (`resolveCategoryPath`,
    `findCategoryById`, `getCategoryAncestors`, `categoryHref`,
    `productHref`). The `(shop)/layout.tsx` fetches the tree once
    per request and passes it to `NavBar` via prop; the per-request
    fetch is deduped via Next.js's
    `next: { revalidate: 300, tags: ["categories"] }`. The header
    autocomplete is a debounced (200 ms) client-side fetch to
    `/products?q=…&limit=5` with AbortController-cancellation on
    resumed typing. Banner slides on the home carousel remain on
    mock data (no banners endpoint exists); the admin ORDERS pages
    went real on 2026-06-10 (the remaining admin pages are still
    mock). 2026-05-29 follow-up:
    `@shop/api` now exports concrete Zod-inferred DTO types
    (`ProductSummary`, `ProductsPage`, `ProductDetail`,
    `CategoryNode`, `CategoryTree`, etc.) from `src/types.ts`,
    consumed by `frontend/src/lib/api.ts`'s helper return-type
    annotations (`Promise<ProductsPage>`, etc.) and by
    `frontend/src/lib/catalog.ts`. This makes typing resilient
    to the workspace-symlink hiccups that can collapse
    `ReturnType<typeof buildApp>` into `any` on some setups —
    callers always get the right shape regardless of how the deep
    AppType inference happens to resolve. Same follow-up shipped
    `hasMerchantReturnPolicy` (14-day EU 2023/2673 withdrawal) on
    every product Offer, absolute URLs everywhere in `@id`/`item`
    fields (Google Rich Results requirement), and omits the
    `Product.image` field when no images exist (closes the
    Rich Results "Missing field image" warning). The
    `frontend/src/app/(shop)/api-demo/` smoke-test page was
    removed since the real storefront pages now demonstrate the
    same RPC patterns end-to-end.

### Next two weeks (do these in order)

16. ❌ **Reconcile docs to reality** (done in this revision —
    2026-05-26). Downgrade IaC claim, downgrade admin-api claim,
    downgrade scheduler claim, downgrade EU CRA claim. Re-upgrade
    the order-confirmation row in COMPLIANCE.md (done in 2026-05-27
    after the template + wire-up shipped). Re-upgrade the storefront
    browsing row in this doc (done in 2026-05-28 after item 15
    shipped).
17. 🟡 **First production deploy — IaC live-apply-validated 2026-06-07;
    maintained prod env pending.** `infra/` now exists: a modular Terraform
    stack — remote S3 state backend with native locking + a `bootstrap`
    sub-stack; a customer-managed KMS key; the one runtime secret in
    SSM Parameter Store (placeholder-seeded, real value set out-of-band
    so it never enters state via that resource); the `shop-api` Lambda
    (Node 22, arm64, `handler.handler`) with a Function URL, a
    pre-created 14-day CloudWatch log group, active X-Ray tracing, and
    a least-privilege execution role; CloudFront with **OAC + sigv4**
    in front of the Function URL (`AWS_IAM`-only, secure-by-default,
    works on the default `*.cloudfront.net` domain with no DNS); the
    five §3.10 alarms on an SNS topic (admin-login + scheduler ones
    gated until those Lambdas exist); and a GitHub **OIDC** deploy role
    (no long-lived keys). Opt-in layers: WAF (managed rule sets +
    rate-limit + Log4Shell KnownBadInputs), Route 53, SES (DKIM + MAIL
    FROM + config set), Amplify. Plus an esbuild Lambda bundle
    (`@shop/api` `build:lambda`; `argon2` shipped unbundled, `@aws-sdk/*`
    left to the runtime) and a CI gate (`.github/workflows/infra.yml`).
    Verified: `terraform fmt` + `validate`, `tflint` (AWS ruleset), and
    `checkov` (121 passed / 0 failed; 16 documented accepted findings in
    `infra/.checkov.yaml`) all green. **Live-apply-validated 2026-06-07** —
    a successful end-to-end `terraform apply` returned HTTP 200 through
    CloudFront → OAC → Lambda. Two apply-time fixes were folded in: the
    Function URL CORS `allow_methods` (AWS rejects methods >6 chars, e.g.
    OPTIONS), and the post-Oct-2025 requirement that CloudFront OAC also
    hold `lambda:InvokeFunction` (not just `lambda:InvokeFunctionUrl`).
    What remains for a *maintained* production environment: a custom
    domain, the schema migrated to Neon, and the frontend deployed. See
    `infra/README.md`.
18. ✅ **Distributed tracing (OpenTelemetry) on `shop-api` — shipped
    2026-06-13.** Closes the **last OWASP A09 item** and the **NIST CSF
    Detect** gap (§5.3, §14). `lib/tracing.ts` starts a `NodeTracerProvider`
    behind `ENABLE_TRACING` (default off; the heavy OTel graph is
    dynamic-imported so cost is paid only when on). Request spans from
    `@hono/otel` (Hono-layer, so it fires on Lambda too — wired outermost
    in `app.ts`); downstream spans from `undici`/`fetch` (the Neon
    serverless query path + HIBP), chosen because `diagnostics_channel`
    instrumentation survives the esbuild bundle where `pg`/`aws-sdk`
    require-patching would silently no-op (§13). Pino `mixin` adds
    `trace_id`/`span_id` to every log line and `X-Request-Id` becomes the
    `app.request_id` span attribute — request id, trace, and logs become
    one handle. Export is vendor-neutral OTLP to
    `OTEL_EXPORTER_OTLP_ENDPOINT`; prod points at the **ADOT collector
    layer** (`enable_tracing` + `adot_collector_layer_arn` in
    `infra/lambda.tf`) which forwards to X-Ray, with X-Ray-compatible
    trace ids (AWS id generator + propagator) that stitch onto the
    Lambda's Active-tracing root segment. The handler force-flushes spans
    before the container freezes. App-level instrumentation + correlation
    are unit-tested (`tests/lib/tracing.test.ts`) and were verified
    against the real libraries (provider, `@hono/otel` span, log
    correlation, and a clean esbuild bundle); the live X-Ray export is
    validated on deploy. Runbook in `infra/README.md`.
19. ❌ **First real DR drill** against a Neon PITR branch. Write
    up the timestamped result. 2 hours.

### Next month

20. ✅ **Address book CRUD** (2026-06-01) — `/addresses` on `shop-api`:
    `GET` (list live), `POST` (create), `PATCH /{id}` (partial update),
    `DELETE /{id}` (soft delete via `deleted_at`). `requireAuth`-gated;
    every row operation scoped to `(userId, deleted_at IS NULL)` so
    not-found / not-yours / removed all collapse to one 404
    (enumeration-resistant, like the per-order 404). Bulgarian 4-digit
    postal-code validation, a 20-address per-user cap
    (`422 /problems/address-limit-reached`), structured
    `address_created/updated/deleted` Pino audit events (field NAMES
    only on update — never PII values). `Address` DTO re-exported from
    `src/types.ts`. Frontend `/account/addresses` page + typed
    `lib/addresses` client, linked from the profile. This **activated the
    previously-dead `addresses` table**: the GDPR export (item 36) and
    account-deletion already read/erased it, but no route could write it,
    so the export always returned an empty `addresses: []`. The
    delivery-address snapshot on orders stays decoupled (orders snapshot
    into `order_delivery_address`), so removing a book entry never
    rewrites order history. 28 integration tests. Spec §6 "адресна книга".
21. ✅ **SQS retry queue for SES — shipped AND live-validated
    2026-06-12** (real SES delivery on the running test stack, plus
    the DLQ → alarm → redrive drill). Closes both EU 2023/2673 Art. 11a(2)
    durable-medium audit margin AND Art. 8(7) confirmation-of-contract
    margin. `@shop/email` gained the `sqs` transport (enqueues the
    rendered email as a versioned envelope), the queue consumer with
    partial-batch semantics, and the `email-fn` Lambda entry +
    esbuild bundle (`npm run build:lambda`, pure JS — builds on any
    OS). `shop-api` selects it via `EMAIL_TRANSPORT=sqs` +
    `EMAIL_QUEUE_URL` (boot fails fast if half-configured).
    Terraform: `sqs.tf` (queue + DLQ, SSE-KMS via the project CMK,
    redrive as standalone resources to break the reference cycle,
    visibility 180 s = 6× function timeout, `maxReceiveCount` 5) +
    `email-fn.tf` (least-privilege role — no DB, no SSM; ESM with
    `ReportBatchItemFailures` + `maximum_concurrency` 2) + the
    email-dlq-depth / email-queue-age alarms, all behind
    `enable_email_queue` (default off). 18 new unit tests in
    `@shop/email`, 3 in `@shop/api`; full §3.7 narrative + §13
    decision entry. **Flags for any future stack:**
    `enable_email_queue = true`, `email_transport = "sqs"`, build the
    email-fn bundle, apply. email-fn ships with UNRESERVED
    concurrency — a reservation draws from the account-wide pool and
    fails the apply on small accounts (hit live 2026-06-12); the
    ESM `maximum_concurrency` (2) is the binding throttle, and
    `email_fn_reserved_concurrency` restores a cap after a
    Service-Quotas raise.
22. ✅ **First admin CRUD slice (orders) — shipped end-to-end
    2026-06-10**, backend + frontend, behind `requireAdmin` in
    `shop-api` (per the 2026-06-08 plan: build in shop-api now, lift
    onto a dedicated `admin-api` Lambda when the surface justifies it).
    Retires the manual `status='accepted'` psql. Backend
    (`routes/admin/orders.ts` + the pure state machine
    `lib/order-status.ts`): paged list (offset, total count, 25/page)
    with status / payment / customer-type / date-range filters and
    search across number, e-mail, phone, company; full detail with
    line items, snapshots, `order_status_history` audit timeline and
    server-computed `allowedTargets`; `POST /:n/status` — the §7
    state machine validated server-side, version-based optimistic
    locking (stale screen → 409 `/problems/order-version-conflict`),
    audit entry in the same transaction, `sendOrderStatusUpdateEmail`
    (item 14) fired best-effort per customer-visible hop; CSV export
    honouring the filters (RFC 4180, UTF-8 BOM, OWASP formula-
    injection escaping). Frontend: `/admin/orders` +
    `/admin/orders/[orderNumber]` real (components/admin/
    OrdersExplorer + OrderDetailPanel, typed client in
    lib/admin/orders/), with the spec's confirmation step, required
    companion fields, expired-pickup marking, and the verbatim
    conflict-refresh UX. 26 integration tests
    (admin-orders.test.ts). **Categories slice shipped 2026-06-15** —
    `/admin/categories/*` (full tree with per-node product + descendant
    counts; create with auto-slug + end-of-layer append; rename / re-image
    / move with cycle prevention; sibling reorder; a deletion-impact
    preview that counts products in active orders; cascade soft-delete of
    the subtree + its products that writes 301 `redirects` rows to the
    surviving parent / home) + the real `/admin/categories` UI. Optimistic
    locking is `updatedAt` + `SELECT … FOR UPDATE` (no `version` column →
    no migration; see §13). First writer of the `redirects` and
    `admin_audit_log` (GDPR Art. 30) tables. 39 integration tests
    (admin-categories.test.ts), pure tree helpers unit-isolated in
    `lib/category-tree.ts`. **Products slice (backend) shipped 2026-06-22** —
    `/admin/products/*`: offset list + category/stock/status filters + name/SKU
    search; create (auto-slug from the Bulgarian name, end-of-category append,
    SKU+slug uniqueness that deliberately SPANS archived rows so a collision is
    a clean 409 not a DB-constraint 500); detail carrying an active-order count
    (the delete warning); edit/move/re-image under the same `updatedAt` +
    `SELECT … FOR UPDATE` optimistic lock as categories; within-category
    reorder; soft-delete writing a 301 `redirect` to the surviving category or
    home (mirrors the category cascade); and restore (clears the redirect,
    re-homes an orphan whose category was removed to uncategorised). Single-SKU
    model — no variant matrix (a §16 door, opened only on a real size/colour
    need); images stored as S3 keys exactly like categories (the presigned
    direct-to-S3 upload pipeline is its own infra-bearing slice — §13). No
    migration (the `products` / `product_images` tables were dormant). 35
    integration tests (admin-products.test.ts) + 17 pure-helper tests
    (product-admin.test.ts). **Products FRONTEND wired 2026-06-27** — the real
    `/admin/products` list (filters + search + offset paging + accessible
    within-category reorder) and the create/edit editor (optimistic-locked,
    archive/restore) in `components/admin/ProductsManager` + `ProductEditor`,
    typed client in `lib/admin/products/`, with product images uploaded through
    the presigned pipeline via the reusable `ImageUploadField` widget (item 46).
    **What remains of the original item:** the dedicated `admin-api` Lambda
    extraction (structural, with item 35's module) and the last mock admin screen —
    archive (banners shipped as item 47, store settings as item 48, account
    management — customers + per-account discounts + spec §10 deletion — as item 49,
    2026-07-03; the read-only **dashboard** as item 50, 2026-07-06; and **archive as
    item 51, 2026-07-07 — so every admin page is now real**; the full
    categories-AND-products interleaved „Наредба" ordering is a later enhancement).
23. ✅ **Scheduler-fn Lambda + the three cron rules — shipped
    2026-06-12, live-validated 2026-06-13** (code + tests + Terraform;
    the manual `aws lambda invoke` drills for all three jobs passed on
    the running stack against Neon — catalog-backup wrote the S3 object
    + `catalog_backups` row, pickup-expiry delivered the Bulgarian admin
    email to the verified inbox, unverified-cleanup returned a clean
    zero-work run. The first drill also surfaced a latent prod bug — the
    `neon-http` driver cannot run `db.transaction(...)` — fixed by
    switching the runtime to the Neon serverless WebSocket driver, see
    §13). The jobs live in `@shop/api`
    `src/jobs/*` — the stateful package — and bundle into their own
    pure-JS Lambda artifact (`npm run build:scheduler` →
    `dist-scheduler/`, builds on any OS like email-fn's). EventBridge
    Scheduler drives them with Sofia-timezone cron + per-schedule
    retry policy + a delivery DLQ (`infra/scheduler.tf`, flag
    `enable_scheduler`, default off):
    hourly **pickup-expiry** (claims `pickup_expired_notified_at` in
    the same UPDATE that selects → exactly-once admin email per spec
    §7; order NOT auto-transitioned), 03:00 **catalog-backup**
    (date-keyed idempotent JSON snapshot of the 4 catalog tables —
    zero PII — to a versioned SSE-KMS 90-day-lifecycle bucket,
    write-only IAM), 04:00 **unverified-cleanup** (day-6 warning with
    a FRESH 24h token via `unverified_deletion_warning_at` claim,
    day-7 HARD delete behind `role='customer'` + `NOT EXISTS(orders)`
    rails, + the 180-day `login_attempts` prune → closes the GDPR
    Art. 5(1)(e) row). Migration `0004_scheduler_jobs` adds the two
    claim markers + partial indexes. Two new email templates (12→14).
    Failure model: async invoke ⇒ job errors alarm on Lambda `Errors`
    (4a), delivery failures park in the scheduler DLQ + alarm (4b);
    no job-level redrive — every job is an idempotent sweep, the next
    tick re-covers it (§13 decision entry). Local ops:
    `npm --workspace @shop/api run job -- <name> [--now=<ISO>]`.
    18 new integration tests in `@shop/api`, 5 template tests in
    `@shop/email`. Replaces the blind placeholder scheduler alarm
    (wrong metric) with the 4a/4b pair. Runbook in `infra/README.md`.
24. ✅ **SLOs as code in `infra/slos.yaml` (OpenSLO v1) — shipped
    2026-06-14.** Three SLOs over a rolling 30-day window: **availability**
    (non-5xx ratio, 99.9%), **order-placement success** (POST /orders non-5xx,
    99.9% — §7.2 aspires to 99.95%, relaxed for early low order volume) and
    **p95 latency** (< 1000ms; §7.2's 200ms warm-path aspiration with
    cold-start headroom). Vendor-neutral OpenSLO — the same portability stance
    as the OTel tracing choice (§8.2) — with `metricSource: CloudWatch` specs
    that document the exact metric each SLI maps to. The file is the objective
    contract; `infra/slo.tf` is its implementation. AWS CloudWatch Application
    Signals SLOs (the AWS-native option, GA Nov 2024) were considered and
    deferred: they want the ADOT auto-instrumentation layer this project
    deliberately does not run (§13 tracing decision), are AWS-proprietary, and
    bill per-SLO. See §7.2.
25. ✅ **Multi-window multi-burn-rate burn-rate alarms — shipped 2026-06-14**
    (`infra/slo.tf`, flag `enable_slo_alarms`, default off). The SLIs are
    derived with **zero new app dependency**: shop-api already emits one
    structured `request_end` line per request, now carrying
    `{ method, path, status, durationMs }` (app.ts), and five CloudWatch Logs
    **metric filters** turn it into SLI metrics — the same mechanism as the
    existing admin-login-failures filter, no PutMetricData on the request path.
    Alarms follow the Google SRE Workbook: each burn tier requires a **long AND
    a short window** to breach (a CloudWatch **composite alarm**), so a
    sustained burn pages while a transient blip self-resolves. Availability
    ships **both** tiers (fast-burn 1h/5m @ 14.4× → page; slow-burn 6h/30m @ 6×
    → ticket); order-success ships the fast-burn page tier; latency is a single
    p95 guard. Because `request_end` is INFO-level, the alarms require the
    deployed Lambda at `log_level = "info"` — a plan-time precondition enforces
    it. Closes the §14 Operational-Excellence "formal SLOs + burn-rate
    alerting" gap. Runbook in `infra/README.md` → "SLO + burn-rate runbook".
26. ❌ **Cloudflare DNS + R2 swap.** ½ day; saves €0.50/mo and
    eliminates two AWS lock-in points.
27. ❌ **Cut CloudWatch Logs retention to 14 days.** 5 min.

### Month 2 — performance + governance

28. ❌ **Lighthouse CI on every PR.** 4 hours.
29. ❌ **Real User Monitoring (RUM).** 2 hours.
30. ❌ **Status page** (statup.fyi or self-hosted). 1 hour.
31. ✅ **Incident-response playbook — shipped 2026-06-15.**
    `docs/INCIDENT-RESPONSE.md`, right-sized for the single-operator
    model and anchored to **NIST SP 800-61r3** (the April-2025 revision
    that re-expresses the IR lifecycle against the six CSF 2.0
    functions), **NIST CSF 2.0** Respond/Recover, and **GDPR Art. 33/34**.
    Contents: a SEV1–4 severity model mapped to this shop's CloudWatch +
    SLO burn-rate alarms; a detect→triage→contain→eradicate→recover
    lifecycle; eight concrete scenario playbooks (5xx surge, Neon
    outage, checkout failure, email-DLQ backlog, admin compromise,
    suspected breach, dependency CVE, catalog corruption) that dispatch
    to the existing §12 / `infra/README.md` runbooks rather than
    duplicating them; the GDPR breach track (awareness→72h decision
    tree, Bulgarian **CPDP / КЗЛД** channels — `kzld@cpdp.bg` + the
    Secure Electronic Delivery System, Art. 33(3) content, Art. 33(5)
    breach register, Art. 34 high-risk data-subject path + Art. 34(3)
    exceptions); an exposure map of what PII exists vs. what is
    hashed/encrypted (no card data — the worst breach class is out of
    scope by design); evidence/forensics sources (`admin_audit_log`,
    Pino/X-Ray, a Neon PITR forensic snapshot); a drill cadence; and
    copy-paste templates (CPDP notification, BG/EN data-subject notice,
    status update, blameless postmortem, breach-register row). Closes
    NIST CSF **Respond** (RS.MA/AN/CO), **CIS Control 17**, and the
    **GDPR Art. 33–34** compliance gaps (§5.4, §14). Carries a
    forward-looking note on the EU **Digital Omnibus** proposal (would
    move to 96h / high-risk-only / a single EU entry point — not yet
    enacted as of June 2026). A documentation deliverable, authored in
    full; the automated-detection and the actual regulatory filing
    activate with the maintained deploy (item 17).
32. ❌ **Asset inventory document.** 2 hours.
33. ❌ **STRIDE threat model doc** — formal pass over major data
    flows. 2 hours.

### Quarter 2+ — growth-stage

34. ❌ **Customer MFA (TOTP / WebAuthn).** ~3 days. Moves OWASP
    ASVS to L2.
35. ✅ **Admin TOTP enrolment + recovery codes — shipped end-to-end
    2026-06-08 (backend + sign-in frontend).** The full server-side flow
    exists at `/admin/auth/*` on `shop-api`: mandatory TOTP MFA (AAL2), two-step
    login (password → signed challenge → TOTP/recovery → session),
    first-login enrolment (`/mfa/setup` + `/mfa/setup/confirm`), 10
    single-use recovery codes, a 30-min/5-fail admin lockout, a 30-min
    admin session idle, the TOTP secret AES-256-GCM-encrypted at rest
    (key in SSM only), and an RFC 6238 replay guard
    (`users.mfa_last_used_step`). Crypto primitives in `@shop/auth`
    (validated against the RFC 6238 Appendix B vectors), DB plumbing in
    `@shop/api lib/admin-mfa.ts`, bootstrap via `@shop/api admin:create`,
    full integration + unit tests. Migration `0003_admin_mfa_replay_guard`
    activates the dormant `mfa_*` columns. The **frontend** shipped too:
    `frontend/src/app/admin/layout.tsx` renders an inline `AdminAuthGate`
    (login → MFA → first-login TOTP enrolment with manual secret entry →
    recovery codes) wired via a typed `lib/admin` client. **What remains**
    is structural — when the admin CRUD surface grows, extract the module
    onto a dedicated `admin-api` Lambda + subdomain.
36. ✅ **GDPR Art. 15 + Art. 20 self-service data export** (May 31,
    2026). Pulled forward from growth-stage: it is a standing legal
    obligation with a one-month statutory response window (Art. 12(3)),
    and it completes the self-service data-rights triad next to Art. 16
    (`PATCH /auth/me`) and Art. 17 (`DELETE /auth/me`). `POST
    /auth/me/export` — current-password re-auth + a per-user frequency
    cap (Art. 12(5) "manifestly excessive" guard). Returns a structured,
    machine-readable JSON copy of the data the subject provided (Art. 20)
    plus a `processingInformation` transparency block (Art. 15);
    credentials/secrets are excluded and the exclusion is disclosed.
    Builder + Zod envelope in `backend/shop-api/src/lib/data-export.ts`;
    best-effort `auth.data-exported` notification email. See README
    "Personal-data export" smoke test.
37. ❌ **Multi-region failover.** ~1 week. Defer until customer
    requires a contractual SLA.
38. ❌ **Move to Neon Scale** when contractual SLA is required.
39. ❌ **Upgrade SLSA to Level 3** — only if needed.

### Accessibility (EAA) — shipped 2026-06-02

40. ✅ **WCAG 2.2 AA / European Accessibility Act conformance.** Closed
    the project's most overdue compliance item: the EAA has been
    *enforceable* since 28 June 2025 (~12 months before this shipped),
    yet the shop was shipping the 2023/2673 withdrawal directive *early*
    while accessibility sat at ⚠️ on all four WCAG principles — the one
    glaring inconsistency for a compliance-first project. The harmonised
    standard is EN 301 549 (WCAG 2.1 AA today, 2.2 AA incoming); we
    targeted **WCAG 2.2 AA**, a superset, so both are covered. Work, all
    sandbox/Windows-testable (no AWS needed, unlike items 17–19):
    - **Contrast (1.4.3 / 1.4.11).** Brand gold (`--primary`, 2.4:1 on
      white) was failing as text. Kept it for fills; added an accessible
      `--primary-strong` (5.6:1) for gold text/links/icons and the focus
      ring; darkened `--muted-foreground` (3.95→5.5:1). Every pair
      verified computationally (OKLCH→WCAG luminance). 67 `text-primary`
      usages swept to `text-primary-strong`.
    - **Operable.** Uniform `:focus-visible` indicator (2.4.13);
      skip-to-content link → `#main-content` (2.4.1); `prefers-reduced-
      motion` neutralises the infinite shimmer + entry animations
      (2.2.2 / 2.3.3); targets ≥ 24 px (2.5.8).
    - **Robust.** The header search became a WAI-ARIA APG combobox
      (role/aria-expanded/controls/activedescendant + Arrow/Enter/Escape);
      `ProductCard` was refactored off the invalid pattern of `<button>`s
      nested inside a card-wide `<a>` to the stretched-link pattern;
      `MobileFiltersDrawer`'s `<span onClick>` became a real
      `SheetTrigger`; cart errors got `role="alert"`.
    - **Continuous audit** (the COMPLIANCE.md §13 remedy): static
      `eslint-plugin-jsx-a11y` hardened in the CI `lint` job + runtime
      `axe-core`/Playwright (`npm run test:a11y`, local/pre-push like
      `next build`) + a manual keyboard/SR checklist.
    - **EAA Annex V**: `/accessibility` statement page (BG/EN) +
      `docs/ACCESSIBILITY.md` (engineering detail). Known limitation
      disclosed: the category menu has no full `menubar` keyboard model
      (arrow-key traversal); previews now open on hover *and* keyboard
      focus, and every category stays keyboard-reachable via the panel.

41. ✅ **Server-side cookie-consent receipts (GDPR Art. 7(1))** (June 3,
    2026). The consent banner had only ever written the choice to
    `localStorage` — a record the data subject owns and can erase, which
    the *controller* cannot produce on demand: the opposite of what Art.
    7(1) requires ("the controller shall be able to demonstrate that the
    data subject has consented"). New anonymous `/consent` route on
    `shop-api` — `POST` records an append-only receipt and mints an
    opaque, strictly-necessary `visitor_id` cookie; `GET` returns the
    current choice — activating the `cookie_consents` table modelled
    since the initial migration (the same "wire a table the schema
    already had" move as the address book, item 20). Choices are
    normalised (dedup + sort), payloads are `.strict()`, the IP is
    coerced through an `inet` guard, and a durable `cookie_consent_
    recorded` audit event pins the policy version. Receipts are disclosed
    in the GDPR export, browser-scoped (`schemaVersion` 1.0 → 1.1). The
    banner's categories were realigned to the spec's {analytics,
    marketing} (the component had drifted to {functional, analytics}) and
    now POST best-effort to the route, while `localStorage` keeps driving
    only banner visibility. Fully sandbox/Windows-testable (no AWS): 10
    new `consent` integration cases + a consent assertion in the export
    suite.

42. ✅ **Guest checkout + order tracking — shipped 2026-06-16.** Closes the
    biggest *functional* spec gap: the "Гост" role (`docs/README.md` §"Роли",
    §7, §8 "Регистрацията е по желание"). Until now `POST /orders` was
    `requireAuth`-only, so the storefront forced registration — contradicting
    the spec. New anonymous surface in `shop-api`: `POST /guest/orders` (cart in
    the body, contact + delivery snapshotted, no account discount, per-IP
    anti-abuse limit, `Idempotency-Key` replay) and `routes/guest.ts`'s
    `/track/:token` capability surface — `GET` (status + timeline + shop contact
    at shipped/ready), `POST /:token/cancel` (the spec's customer/guest
    cancel-while-`processing` rule, shared with the new authenticated
    `POST /orders/:n/cancel` via `lib/order-cancellation.ts`), the 14-day
    withdrawal via token (reusing `lib/withdrawal.ts`, refactored to an
    order-resolved core), and `POST /track/find` (lost-link resend, 3/hour/IP,
    enumeration-resistant). Frontend: `/checkout/review` branches on auth →
    guests place via `/guest/orders` and land on the public `/track/[token]`
    page; `/track/find` in the footer. **No migration** — activates the dormant
    `orders.guest_track_token` column. Token design is a durable, plaintext
    256-bit capability URL (see §13). Tests: `tests/routes/guest.test.ts` +
    `tests/lib/guest-track.test.ts`. Corporate guest checkout (EIK at checkout
    without an account) stays a scoped follow-up; the `redirects`-serving
    follow-up this item flagged shipped as item 43.

43. ✅ **Site-level crawlability & SEO — sitemap, robots, 301 serving — shipped
    2026-06-16.** The shop had sophisticated *page-level* SEO (JSON-LD `@graph`,
    canonical URLs, OpenGraph, Rich-Results compliance) but **no** *site-level*
    primitives — no sitemap, no robots.txt — and the `redirects` table the
    category delete writes (item 22) was never served, so deleted URLs 404'd
    instead of 301'ing (link-equity leak). One coherent slice closes all three:
    - **Dynamic `/sitemap.xml`** (`app/sitemap.ts` ← new public `GET /sitemap`):
      every live category + product as an absolute URL with an ACCURATE
      `lastmod` from `updated_at` (Google ignores `lastmod` site-wide once it
      looks fabricated, so it's built from the source of truth via the same
      `category-tree.ts` URL helpers the storefront serves — no drift). Degrades
      to static-only if the API blips; single file under the 50K cap (shard via
      `generateSitemaps()` past it; trigger documented).
    - **`/robots.txt`** (`app/robots.ts`): catalog open, private routes
      disallowed (`/account /admin /checkout /cart /search /track /api`), the
      2026 AI-crawler policy (block training crawlers, allow search/retrieval —
      both an SEO and a serverless-cost choice), sitemap pointer, and a blanket
      `Disallow: /` on any non-production host.
    - **301 redirect serving** (`GET /redirects/resolve` + the
      `/products/[...path]` catch-all): resolves a deleted URL to its surviving
      target on the would-be-404 path only — NOT in the thin proxy (§13) —
      collapsing redirect chains server-side with a cycle guard. `permanentRedirect()`
      emits 308, which Google treats as 301. Fulfils the spec's
      §"Пренасочване при изтрит ресурс" in full — the 301 AND the „вече не е
      наличен" toast (`MovedNotice`, driven by a crawler-invisible `#moved`
      fragment).
      Pure logic in `lib/redirect-resolve.ts` + `lib/sitemap.ts` (injectable,
      DB-free unit tests). Tests: `tests/routes/seo.test.ts` +
      `tests/lib/seo.test.ts`. No migration. Design rationale in §13.

44. ✅ **Distributed (Postgres-backed) rate limiting — shipped 2026-06-19.**
    Closed a serverless-correctness defect, not a missing feature: the public
    guest limiters (lost-link resend 3/h/IP, anonymous placement 30/h/IP) kept
    their counters in a per-process `Map`, which on Lambda is per-CONTAINER — the
    effective ceiling multiplied by warm-container count and reset on cold start,
    so the spec's hard "3 заявки на час от един IP" guarantee did not actually
    hold in production. New `rate_limit_counters` table (migration
    `0005_rate_limit_counters`, composite-PK fixed-window counters) + a
    `lib/rate-limit-db.ts` limiter whose check-and-count is a single atomic
    `INSERT … ON CONFLICT … DO UPDATE SET count = count + 1 WHERE count < limit
    RETURNING count` — race-free under the row lock with **no advisory lock**
    (proved with a 50-parallel-hit "exactly-the-limit" test). The guest routes
    now `await` it; the old in-memory `createRateLimiter` was removed (its only
    consumer was the guest surface). `csp-report` and `data-export` stay
    in-memory **by explicit decision** (fire-hose fail-open noise control; and a
    secondary brake behind mandatory password re-auth, respectively) — both now
    documented in §13 rather than left as silent per-container limiters. The
    daily `unverified-cleanup` sweep prunes counter rows older than 2 days (no
    new cron). Tests: `tests/lib/rate-limit-db.test.ts` (6, incl. the
    cross-instance shared-budget proof) + the new prune case in
    `tests/jobs/unverified-cleanup.test.ts`. Brings the guest surface up to the
    DB-backed-counter standard the auth surface (lockout, token-count limits)
    already met. Full rationale in §13.

45. ✅ **Framework errors return their true HTTP status, not a blanket 500 —
    shipped 2026-06-22.** A correctness defect, not a feature. The global
    `onError` mapped `ApiError` and `ZodError` to Problem responses but sent
    everything else to 500 — including the `HTTPException(400)` Hono throws on a
    malformed JSON body (the parse fails *before* the Zod `defaultHook`, so it is
    neither). A client posting unparseable JSON got a **500**, which both (a)
    tells the client the server failed and an identical retry may work (RFC 9110
    §15.6 — false here) and (b) burned the availability SLI's error budget (it
    counts `status >= 500` on `request_end`, graceful 500s included — §8.5) on a
    client mistake, the precise 4xx-vs-5xx confusion the Google SRE Workbook
    warns against. New pure `lib/error-response.ts` `frameworkProblem()` honours
    an `HTTPException`'s real status (malformed JSON → `400
    /problems/malformed-json`; others → `about:blank` + the RFC 9110 reason
    phrase) and degrades a raw `SyntaxError` to the same 400; unknown throws still
    fall through to the 500 path, so real faults are never masked, and the body is
    never reflected back in `detail` (PII). Tests:
    `tests/lib/error-response.test.ts` (10) + `tests/routes/error-handling.test.ts`
    (3). No migration, no infra, no new dependency. Full rationale in §13.

46. ✅ **Image-upload pipeline — presigned POST + server-side magic-byte
    validation — shipped 2026-06-22.** The keystone that activates every image
    key the catalog already stores: until now products / categories / banners
    held S3 keys (`images.ts` builds the URL) but **no entity could put bytes
    behind a key** — the catalog could only be seeded with keys pointing at
    nothing. Closes the single largest cross-cutting functional gap, and unblocks
    real product/category images AND the still-mock home banners in one build.
    Scope: a private **assets bucket** (`pending/` upload target + `uploads/`
    served prefix), a **CloudFront + OAC** distribution serving only `uploads/`
    (via `origin_path`), the **assets-fn** validator Lambda (magic-byte check →
    promote genuine images / delete everything else), and shop-api's presign
    surface `POST /admin/uploads` + `GET /admin/uploads/status`
    (`routes/admin/uploads.ts`). The browser uploads straight to S3 with a
    short-lived presigned POST — never through Lambda — whose policy pins the
    exact key, a `content-length-range`, and the `Content-Type`; the validator
    re-derives the true type from the bytes (a declared MIME is not proof). Pure
    helpers in `lib/asset-upload.ts` (allowlist, key layout, request validation,
    the magic-byte sniffer) are the single source of truth the route AND the
    validator import. Behind `enable_asset_uploads` (default off, `infra/assets.tf`);
    one new first-party dependency (`@aws-sdk/s3-presigned-post`); no migration.
    Tests: `tests/lib/asset-upload.test.ts` (pure helpers, real format heads),
    `tests/routes/admin-uploads.test.ts` (the presign route, S3 adapters
    injected), `tests/assets/validate-upload.test.ts` (the validator). Reusable
    frontend client in `frontend/src/lib/uploads/`, now consumed by the
    accessible `ImageUploadField` widget (components/admin/) wired into the
    product editor (2026-06-27 — drag-or-pick with a WCAG 2.5.7 single-pointer
    path, an ARIA live-region status, and client-side type/size pre-checks
    mirroring the server allowlist). **What remains:** reusing that same widget
    in the category editor when that slice lands (the **banner** editor already
    reuses it — item 47), and the optional Sharp transcode/EXIF-strip
    enhancement (§3.6, §13). Full rationale in §13.

47. ✅ **Banner management + accessible homepage hero — shipped 2026-06-29.**
    The most *visible* remaining mock: the homepage hero carousel rendered from
    `frontend/src/lib/mock-data/banners.ts`, with no backend at all. This slice
    activates the **dormant `banner_slides` table** (modelled since migration
    0000, referenced by the upload pipeline's key layout, but never written —
    the same "wire a table the schema already had" move as the address book and
    cookie-consent receipts) and closes the spec's §"Управление на банер" end to
    end. Backend: public `GET /banners` (active slides, ETag + 5-min edge cache,
    like `/categories`) and `/admin/banners/*` (`requireAdmin`→404; list, create
    with end-of-list append, edit/re-image/re-link/show-hide toggle under the
    same `updatedAt` + `SELECT … FOR UPDATE` optimistic lock as
    categories/products, reorder with the exact-set guard, **hard delete** — a
    banner has no order history or URL to 301, and the `isActive` toggle already
    covers hide-without-delete; every change appends an `admin_audit_log` row).
    The click-through `linkUrl` is validated server-side to a **same-origin
    path** (pure `lib/banner.ts`) so a promo can never become an open-redirect or
    `javascript:`-href XSS vector. Frontend: the real `/admin/banners` screen
    (`components/admin/BannersManager`) reuses the **`ImageUploadField`** widget
    unchanged with `kind="banners"` + `max=1` — proving the pipeline's "build
    once, serve products + categories + banners" promise (item 46) — and the
    homepage hero now reads the live `/banners` API. The `BannerSlider` was
    brought to **WCAG 2.2 SC 2.2.2 (Pause, Stop, Hide)** conformance: a visible
    pause/play control for the >5s auto-rotation, rotation that pauses on
    hover/focus and never starts under `prefers-reduced-motion`, an
    `aria-live="off"`-while-rotating region, and the LCP hero image marked
    `fetchPriority="high"` + eager (2026 Core-Web-Vitals guidance). Single-SKU of
    banner work: no scheduling windows (the spec models only an active toggle).
    No migration; one pure helper + 28 new test blocks (admin-banners 16,
    banners 4, banner 8). Full rationale in §13.
48. ✅ **Admin store settings — shipped 2026-06-30.** The fifth admin CRUD
    slice, and the one that retires a standing architectural smell: operator-
    editable business config (shop phone, address, opening hours, default pickup
    window, admin-notification recipient) lived in environment variables, so
    changing the shop phone needed a redeploy. This slice moves it onto the
    **dormant key-value `settings` table** (modelled since migration 0000, only
    ever seeded — never written by a route), keeping it runtime-editable while
    **secrets remain in env/SSM** (the config-vs-data line; see §13). A pure,
    unit-tested **typed registry** (`lib/settings.ts`) is the single source of
    truth — per-key Zod schema + default + public/private flag — and does the
    write-side validation/normalisation (trim, control-char strip, length cap,
    phone/email formats, strict unknown-key allow-list) that, paired with React's
    output encoding under the strict CSP, closes the stored-XSS surface. Backend:
    public `GET /settings` (the four customer-facing keys only, camelCase, ETag +
    5-min edge cache like `/banners`) and `/admin/settings` (`requireAdmin`→404;
    GET all values + a `MAX(updated_at)` document version; PATCH one-or-more keys
    under a document-level optimistic lock → `409
    /problems/settings-version-conflict`, with an `admin_audit_log` row).
    **Every shop-contact surface now reads settings, not hardcoded copy**
    (the follow-up fix after the first pass only wired the contact page): the
    storefront **footer**, **contact page**, **delivery page**, and the checkout
    **"От магазина" pickup** option read the public `GET /settings`; the guest
    **order-tracking page** (now also showing address + hours, per spec) and the
    **ready-for-pickup email** read the same settings server-side through a shared
    `lib/shop-contact.ts` resolver (settings → env/derived fallback). Purpose-
    specific legal addresses (`privacy@`, `security@`, `accessibility@`, the
    withdrawal `contact@`) stay static by design — they are not the configurable
    shop contact. Frontend: the real `/admin/settings` form
    (`components/admin/SettingsManager`) replacing the mock. No migration; 31 new
    test blocks (admin-settings 10, settings 4, settings 12, shop-contact 3 +
    2 email-template cases). **Follow-ups** (noted, not done): wire
    `admin_notification_email` into the actual admin notification sends, and
    surface `default_pickup_deadline_days` as the prefill in the admin orders
    "ready for pickup" action. Full rationale in §13.
49. ✅ **Admin account management — shipped 2026-07-03.** The sixth admin CRUD
    slice: `/admin/customers` (list + detail) + the **write side of the dormant
    `discounts` table** (per-account B2B percentage, `applied_at` optimistic lock,
    `admin_audit_log`) + GDPR Art. 17 account deletion behind the spec §10
    active-order guard, reusing the shared `executeAccountDeletion`. Surfaces the
    per-account discount through the server cart so the cart drawer + both checkout
    steps show the discounted „Общо" (integer-cent floor matching the order; guests
    get 0). Logs admin PII **reads** (`admin_customer_viewed`), not only writes. No
    migration. Full rationale in §13.
50. ✅ **Admin dashboard — shipped 2026-07-06.** The real `/admin` landing screen,
    un-mocking the last high-traffic admin page (retires `mock-data/{orders,
    customers,banners}.ts`). `GET /admin/dashboard` (`requireAdmin`→404) returns
    realised-sales KPIs (orders / revenue / average order value for the Europe/Sofia
    month + today, `cancelled`/`returned` excluded so the three share one population
    and AOV is a true per-order average), new-customer counts, the operational action
    queue (new orders awaiting acceptance, expired pickups, out-of-stock), a catalog
    snapshot, the recent-orders feed, and a 14-day realised-sales trend — all
    **on-the-fly indexed aggregates** over the existing tables (no migration;
    materialised-view / summary-table promotion documented for Tier 3+). No
    web-analytics KPIs are fabricated — only what the DB knows is shown (traffic /
    conversion / LTV arrive with the RUM pipeline, item 29). The trend UI is an
    **accessible SVG** (`role="img"` + a visually-hidden data table, WCAG 1.1.1).
    Emits `admin_dashboard_viewed` (a PII read log; no `admin_audit_log` row — a read
    is not a state change). 19 new test blocks (admin-dashboard 10, dashboard-metrics
    9). At ship time `archive` was the last admin page still on mock data — closed
    the next day by item 51. Full rationale in §13.
51. ✅ **Admin archive & restore — shipped 2026-07-07.** The seventh admin CRUD
    slice, and the one that makes the admin panel **fully real** — archive was the
    last screen on mock data (`mock-data/{products,categories}.ts`, now deleted).
    `GET /admin/archive` (`requireAdmin`→404) lists the soft-deleted products +
    categories awaiting restore and the point-in-time `catalog_backups` snapshots,
    with a `backupsAvailable` flag. Two recovery mechanisms, honestly separated (2026
    "trash + backups" practice): per-item **restore** of a soft-deleted entity —
    served by each entity's own route, so this slice adds the **missing** `POST
    /admin/categories/:id/restore` (mirrors product-restore: un-archive, clear the
    301, re-home an orphan to root, `409 /problems/category-restore-conflict` on a
    live slug collision — closing a real gap, since a cascade-soft-deleted category
    previously could not be restored via any API) — and an on-demand **backup**
    (`POST /admin/archive/backup`, the spec §12 one-button „Ръчно архивиране"): the
    catalog-backup job gained a `manual` mode (timestamped key + its own
    `kind='manual'` row, never clobbering the daily scheduled snapshot), gated behind
    the backup bucket (`503 /problems/backups-not-configured` until set; shop-api's
    exec role granted `s3:PutObject` on that bucket behind `enable_scheduler`), and
    audited (`backup.create`). Frontend `components/admin/ArchiveManager`. No
    migration. 17 new test blocks (admin-archive 16 + the catalog-backup manual
    case). Full rationale in §13.
52. ❌ **Restore a catalog snapshot over the live catalog.** The one archive
    capability deliberately deferred from item 51: replaying a chosen
    `catalog_backups` snapshot back into the catalog tables (spec §12
    „възстановяване до избрана версия"). High blast radius — it overwrites live rows,
    so it wants a dry-run **diff/preview** + an explicit „Разбирам последствията"
    confirm + a single transactional replay, and must reconcile products created
    since the snapshot. Order history is unaffected (orders snapshot their line
    items — spec §12). Its own slice; ~half a day.

**Doing items 15–27 closes every meaningful 2026 gap in ~4–6
working days. Items 28–33 raise the quality bar further at ~3 more
days. Items 34+ are growth-stage; not blocking on A+.**

---

## 16. Forward-looking design considerations

Items that are not on the formal §15 roadmap but are worth recording
now so the optionality stays open as the shop grows.

### 16.1 Growth-tier viability at a glance

The architecture has been sized for the following tiers. None of the
breakpoints are sharp; treat them as orientation.

| Tier | Customers | Orders / mo | Sweet-spot architectural posture |
|---|---|---|---|
| 1 — Founder | 0–500 | 0–10 | Today's repo is already over-prepared for this tier. Investment is forward-looking, not wasteful. **Missing: actual production deploy.** |
| 2 — SMB | 500–10K | 50–500 | Architecture's sweet spot. Needs items 16–20 from §15 in place before crossing in. |
| 3 — Mid-market | 10K–100K | 500–5K | Operational maturity gaps (§15 items 24–33) need to be closed before this tier. Cloudflare swap (§15 item 26) saves real money here. |
| 4 — Regional | 100K–500K | 5K–50K | Single-admin model breaks; Amplify's lack of on-demand revalidation becomes the constraint that may push the frontend off Amplify; Postgres tsvector search needs to graduate to Meilisearch / Algolia. |
| 5 — National | 500K+ | 50K+ | Geographic distribution becomes important. Neon does not yet support multi-region active-active for writes (only read replicas) — confirm before assuming. |

### 16.2 Multi-tenant `tenant_id` — cheap optionality now, expensive retrofit later

The schema today is single-shop, single-admin. If the owner ever
wants to launch a second shop (white-label franchise, sister brand,
multi-tenant SaaS pivot), every table that holds shop-scoped data
will need a `tenant_id` retro-fit. That is a small fixed cost now
(add a `tenant_id` column with default of a single-row `tenants`
table) and a large variable cost later when there are millions of
rows of orders and customers spread across hundreds of indexes. The
application never needs to read it until the second tenant exists.
Not on the §15 roadmap; revisit when there is a credible signal that
a second tenant is coming.

### 16.3 Search infrastructure threshold

`docs/README.md` describes search as a product feature; the
storefront `/search` is wired to `/products?q=…` (simple `ILIKE`
matching on name + code) since 2026-05-28. The intended first
upgrade is Postgres `tsvector` + a `pg_trgm` index on
`products.name`. That topology scales comfortably to roughly 50K
active SKUs with p95 latency under 200 ms. The migration door past
that threshold is Meilisearch (self-hosted small instance, ~€10/mo)
or managed (Algolia, Typesense Cloud). Document the trigger now:
**"when our catalog exceeds 20K active SKUs OR p95 search latency
exceeds 200 ms, migrate."** This avoids both premature optimisation
and surprise-replatform.

### 16.4 Payment-method door (cards) — SAQ A path

Cash-on-delivery and pay-at-store removes the entire PCI-DSS audit
scope, which is a deliberate, smart choice. PCI DSS 4.0.1 became
fully effective April 1, 2025 with the first SAQ A assessments due
in 2026 — even the lightest merchant tier now requires
script-integrity controls. By staying out of scope the shop avoids
quarterly Approved Scanning Vendor scans, the new SAQ A
script-management attestation, and a real annual time cost.

**If card payment is ever added**, restrict the work to SAQ-A-
eligible redirect / iframe patterns (Stripe Checkout, Stripe
Elements iframe). The current strict CSP would block a Stripe iframe
without an explicit `frame-src https://js.stripe.com` allow-list
entry. The implementation work would be: add `frame-src` to the
proxy CSP, embed the Stripe iframe on `/checkout/review`, wire a
new `paymentMethod = card` enum value into orders, capture only the
Stripe `paymentIntentId` on the order row (no PAN). This keeps the
shop on SAQ A (the lightest tier) and avoids the heavier SAQ A-EP
that direct PAN handling would trigger.

### 16.5 Things to defer with confidence

The following are correctly listed in §15 but bear repeating as
items not to spend energy on before there is demand-side signal:

- **Customer MFA (TOTP / WebAuthn)** — for a cash-on-delivery shop
  with no card data and no shop-wallet balance, the realistic value
  of taking over a customer account is low. Friction added to
  registration / recovery costs more than it saves. Defer until a
  credible incident pattern emerges or a customer specifically asks.
- **Multi-region failover** — Bulgaria-only operation makes
  eu-central-1 plenty.
- **SLSA Level 3** — useful only if a customer contract requires
  it; the operational complexity over Level 2 is non-trivial.
- **Cloudflare proxy swap** — saves real money at Tier 3+ but is a
  cost optimisation, not a 2026-standards gap. Ship after a
  production deploy stabilises.

---

## 17. Glossary

Briefly, every acronym in this document and its siblings:

- **ACM** — AWS Certificate Manager. Free TLS certs.
- **ADOT** — AWS Distro for OpenTelemetry.
- **Argon2id** — modern password hashing function, OWASP and RFC
  9106 standard.
- **ASVS** — OWASP Application Security Verification Standard.
  L1 = baseline; L2 = sensitive data; L3 = high-assurance.
- **CIS Controls** — Center for Internet Security's 18-control
  framework. IG1 = small business baseline.
- **Cold start** — first invocation of a Lambda function after idle.
- **Cosign** — Sigstore's code-signing CLI.
- **CRA** — EU Cyber Resilience Act. Sept 11, 2026 reporting
  deadline (out of scope for this SaaS).
- **CSF** — NIST Cybersecurity Framework. Version 2.0 (2024).
- **CSP** — Content Security Policy.
- **CSPRNG** — Cryptographically Secure Pseudo-Random Number
  Generator.
- **CSRF** — Cross-Site Request Forgery.
- **CU / CU-hour** — Neon Compute Unit. 1 CU = 1 vCPU + 4 GB RAM.
- **CWE** — Common Weakness Enumeration.
- **CycloneDX** — OWASP-hosted SBOM format. Alternative: SPDX.
- **DORA** — DevOps Research and Assessment metrics.
- **DSAR** — Data Subject Access Request.
- **ETag** — HTTP cache validator.
- **Fulcio** — Sigstore's certificate authority for keyless
  signing.
- **HIBP** — Have I Been Pwned.
- **HSTS** — HTTP Strict Transport Security.
- **IAM** — AWS Identity and Access Management.
- **IG1** — CIS Controls Implementation Group 1.
- **ISR** — Incremental Static Regeneration (Next.js).
- **MFA** — Multi-Factor Authentication.
- **NIS2** — EU directive on cybersecurity.
- **OAC** — CloudFront Origin Access Control. Signs CloudFront→origin
  requests with sigv4 so the origin (here the `shop-api` Lambda
  Function URL) accepts traffic only from a specific distribution.
- **OIDC** — OpenID Connect. Used so GitHub Actions assumes an AWS IAM
  role via short-lived federated tokens — no long-lived access keys.
- **OpenSLO** — YAML format for declarative SLO definitions.
- **OpenTelemetry / OTel** — vendor-neutral standard for traces,
  metrics, logs.
- **OWASP Top 10** — most critical web vulnerabilities. 2025
  edition is current.
- **PCI-DSS** — Payment Card Industry Data Security Standard.
  Not in scope (no PAN).
- **PgBouncer** — Postgres connection pooler.
- **PII** — Personally Identifiable Information.
- **PITR** — Point-in-Time Recovery.
- **PPR** — Partial Prerendering (Next.js 16).
- **Rekor** — Sigstore's transparency log.
- **RPO** — Recovery Point Objective.
- **RTO** — Recovery Time Objective.
- **RUM** — Real User Monitoring.
- **SAST** — Static Application Security Testing.
- **SBOM** — Software Bill of Materials.
- **SCA** — Software Composition Analysis (deps).
- **SES** — AWS Simple Email Service.
- **SLI / SLO / SLA** — Indicator / Objective / Agreement.
- **SLSA** — Supply-chain Levels for Software Artifacts.
- **SPOF** — Single Point Of Failure.
- **SQS** — AWS Simple Queue Service.
- **SRE** — Site Reliability Engineering.
- **SSM Parameter Store** — AWS Systems Manager Parameter Store.
- **STRIDE** — Spoofing / Tampering / Repudiation / Info-
  disclosure / DoS / Elevation-of-privilege.
- **TOTP** — Time-based One-Time Password.
- **WAF** — Web Application Firewall.
- **WAL** — Postgres Write-Ahead Log.
- **WCAG** — Web Content Accessibility Guidelines. 2.2 AA is the
  European Accessibility Act baseline.
- **ZTA** — Zero Trust Architecture.

---

*This is the single technical doc. For the auditor-facing
standards-by-standards matrix, see `COMPLIANCE.md`. For the
functional / product specification, see `docs/README.md`
(Bulgarian).*
