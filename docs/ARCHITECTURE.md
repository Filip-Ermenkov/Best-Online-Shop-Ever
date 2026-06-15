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
> Last updated: 2026-06-14. Reality-aligned: the `infra/` IaC is
> live-apply-validated (a test deploy returned 200 end-to-end); the
> **admin authentication backend** (mandatory TOTP MFA, `/admin/auth/*`)
> shipped 2026-06-08; the **durable email queue** (item 21) and
> **scheduler-fn** (item 23) shipped + live-validated 2026-06-12/13;
> **distributed tracing** (OpenTelemetry, item 18) shipped 2026-06-13 —
> closing the last OWASP A09 / NIST CSF Detect gap (§8.2); and **SLOs as
> code + multi-window burn-rate alerting** (items 24/25) shipped 2026-06-14
> (`infra/slos.yaml` + `infra/slo.tf`, §7.2/§8.5). No maintained production
> environment is kept running yet; the admin frontend UI is pending.

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
  2026-06-10, backend and frontend. Still pending: the REMAINING admin CRUD
  pages (products, categories, customers, banners, archive, settings — mock
  data) and the dedicated **`admin-api`** Lambda the admin panel will
  eventually live on.

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
  live catalog API 2026-05-28. The admin sign-in (2026-06-08) and the
  admin **orders** pages (list + detail + status transitions,
  2026-06-10) are real.
- Pages still on mock data: home banner carousel, the checkout
  courier-office picker, and the remaining `/admin/*` pages
  (dashboard, products, categories, customers, banners, archive,
  settings).

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
  (`/admin/auth/*`, mandatory TOTP MFA — see below) and the first CRUD
  slice — **order management** (`/admin/orders` list / detail /
  state-machine status transitions / CSV export, shipped 2026-06-10) —
  live in `shop-api` today as self-contained, portable Hono modules
  (`routes/admin/*`) that will move here when the admin CRUD surface
  justifies a separate Lambda + subdomain.
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
`0003_admin_mfa_replay_guard.sql`, `0004_scheduler_jobs.sql`. The
running test stack now also has these five applied to a Neon branch
(2026-06-13) — the scheduler-fn drills ran against it.

**Schema scope:** 30 tables, 32 FKs, 46 indexes, 10 enums.

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

### 3.6 Object storage — Amazon S3 (planned)

**Today:** No S3 integration. The `images.ts` helper builds URLs
against a configured base; locally that's a `cdn.duda1.bg`-style
placeholder. There is no admin upload path (the admin Lambda doesn't
exist yet).

**Target:** S3 with three roles —

1. **Original product images** in a `temp/` prefix (deleted after
   processing).
2. **Three pre-optimised WebP variants** per image (1200×1200,
   400×400, 150×150 — about 2 MB per product total).
3. **Daily catalog backups** (full categories+products JSON snapshot
   with 90-day retention; >90d moves to Glacier Instant Retrieval).

CloudFront would sit in front of the image bucket. **Sharp.js
processes at UPLOAD time, not at request time.** Admin would use an
S3 presigned PUT URL (15-min TTL, 10 MB cap, JPG/PNG only) to bypass
Lambda's 6 MB payload cap, then trigger
`POST /admin/process-image` to run Sharp.

**Possible migration to Cloudflare R2** for free egress and to
eliminate one AWS lock-in point. See §10.

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

**Today:** Three workflows in `.github/workflows/` —

- **`ci.yml`** — five parallel jobs (`typecheck`, `lint`,
  `auth-tests`, `email-tests`, `api-tests`) on every PR and push to
  `main`. `api-tests` uses a Postgres 17 service container.
- **`codeql.yml`** — CodeQL `security-extended` query suite on
  JavaScript / TypeScript + the `actions` query pack on workflow
  YAML. Runs on PRs, push to `main`, and a Sunday 03:00 UTC weekly
  cron.
- **`sbom.yml`** — generates a CycloneDX 1.6 SBOM per workspace via
  `@cyclonedx/cyclonedx-npm`, signs each via
  `actions/attest-build-provenance` (GitHub OIDC → Sigstore Fulcio
  → Rekor), attaches to releases.

All three workflows pin third-party actions to commit SHAs, run
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
   the response — no auth flicker. Home banners render from
   `frontend/src/lib/mock-data/banners.ts` (still mock).
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
    2026-06-10 — list, filters, search; the dashboard TILES are still
    mock).
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
- **GDPR Art. 33–34** (breach notification 72h): ⚠️ no playbook
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
- `package-lock.json` committed, reproducible installs.
- Dependabot alerts enabled.
- `npm audit` runs in CI on every PR.

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

- **DR drill** — restore a Neon branch from backup, verify
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
`catalog_backups`
(kind='scheduled', one row per key — the table the restore page will
list from). The RESTORE half (admin Archive page + replay) is still
the admin-api slice; until it ships, restore = read the S3 object and
replay it manually (psql / a one-off script).

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
- **Single admin account** — multi-admin is out of scope.
- **Uniform strict CSP** — defends against the SPA-soft-navigation
  bypass documented in §5.2.

---

## 14. Honest assessment vs A+ target

**Current state, scored against AWS Well-Architected:**

| Pillar | Today | What's missing for A+ |
|---|---|---|
| Operational Excellence | B+ | Production deploy, DORA metrics, scheduled DR drills, incident postmortem template, status page (distributed tracing ✅ item 18, 2026-06-13; formal SLOs-as-code + multi-window burn-rate alerting ✅ items 24/25, 2026-06-14 — `infra/slos.yaml` + `infra/slo.tf`, awaiting live traffic to exercise) |
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
| NIST CSF 2.0 (Respond function) | ⚠️ Partial | Incident playbook |
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
| GDPR Art. 33–34 (72h breach) | ⚠️ | Playbook |
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
    (admin-orders.test.ts). **What remains of the original item:**
    the dedicated `admin-api` Lambda extraction (structural, with
    item 35's module) and the OTHER admin CRUD slices — products,
    categories, customers, banners, settings (each its own slice).
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
31. ❌ **Incident playbook.** 3 hours.
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
