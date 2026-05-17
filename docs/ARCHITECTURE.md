# Architecture — Best Online Shop Ever

> The single technical doc that explains how the system is built, how
> it runs, what it costs, and what's standing between today's state and
> A+ on every relevant 2026 standard.
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
> Last updated: 2026-05-16.

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
16. [Glossary](#16-glossary)

---

## 1. What this product is

A Bulgarian-language B2C and B2B e-commerce shop, hosted in AWS
Frankfurt (`eu-central-1`) for GDPR data-residency. Sells physical
goods only. Payment is **cash on delivery** or **pay at the physical
store** — no card numbers are ever received, stored, or transmitted.
That one fact removes PCI-DSS from scope and makes "production-grade"
reachable without a payment-processor audit.

Three actors in the code:

- **Guests** — browse and order without registering; cart stored per
  browser tab.
- **Customers** — registered users, individuals or corporate (with
  VAT/EIK fields).
- **Administrator** — exactly one account, on a separate subdomain
  (`admin.domain.bg`), gated by mandatory TOTP MFA.

Functional scope is in `docs/README.md`. Technical scope is this doc.

---

## 2. Architecture at a glance

```
                              Internet
                                  │
                      ┌───────────▼────────────┐
                      │   DNS                  │
                      │   (Route 53 today,     │
                      │    Cloudflare planned) │
                      └───────────┬────────────┘
                                  │
                      ┌───────────▼────────────┐
                      │   Edge protection      │
                      │   (AWS WAF + Shield;   │
                      │    Cloudflare planned) │
                      └───────────┬────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
         shop.domain.bg                       admin.domain.bg
              │                                       │
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │  AWS Amplify          │                │  AWS Amplify          │
   │  Next.js 16 PPR+ISR   │                │  Next.js 16 (admin)   │
   │  CloudFront CDN       │                │  CloudFront CDN       │
   └──────────┬───────────┘                └──────────┬───────────┘
              │                                       │
              ▼                                       ▼
   ┌──────────────────────┐                ┌──────────────────────┐
   │  Lambda shop-api     │                │  Lambda admin-api    │
   │  Hono + Drizzle      │                │  Hono + Drizzle      │
   │  Function URL        │                │  Function URL        │
   └──────────┬───────────┘                └──────────┬───────────┘
              │                                       │
              └──────────────────┬────────────────────┘
                                 │
                                 ▼
                       ┌──────────────────┐
                       │  Neon PostgreSQL │
                       │  HTTP driver +   │
                       │  PgBouncer       │
                       └────────┬─────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Amazon S3       │
                       │  images, backups │
                       │  → R2 planned    │
                       └──────────────────┘

   EventBridge ──► Lambda scheduler-fn (3 cron rules)
   Lambda * ──► Amazon SES (8 transactional templates)
   Lambda * ──► CloudWatch Logs / Metrics / 5 Alarms
   Lambda * ──► SSM Parameter Store (runtime secrets)
   ACM ──► CloudFront + Amplify (auto-renew TLS)
```

The shortest description: **Next.js frontend on Amplify; Hono backend
on Lambda; Neon Postgres; AWS WAF + CloudFront + S3 + SES +
EventBridge + CloudWatch + Parameter Store gluing it together.**
Everything below is detail.

---

## 3. Layer by layer

### 3.1 DNS

Route 53 hosted zone, $0.50/mo. Planned move to Cloudflare Free DNS —
see §10 and the recommendation in §15.

### 3.2 Edge protection

**AWS WAF + AWS Shield Standard** in the current configuration. The
WAF runs:

- `AWSManagedRulesCommonRuleSet` (OWASP Top 10 baseline — XSS, path
  traversal, bad inputs)
- `AWSManagedRulesSQLiRuleSet` (SQL injection)
- Custom rate-limiting rules on `/auth/login`, `/auth/resend-
  verification`, `/track/:token`
- Stricter rules attached only to `admin.domain.bg`

**AWS Shield Standard** is free L3/L4 DDoS protection that ships with
every CloudFront distribution. **Cloudflare's free tier provides
materially stronger DDoS coverage (unmetered L3/L4/L7).** This is one
of the few places the current architecture is genuinely under-
protected vs cheaper alternatives.

Cost today: $5/mo WebACL + $2/mo for two managed rule packs + $0.60
per million requests.

### 3.3 Frontend — Next.js 16 on AWS Amplify

Two Amplify apps, two CloudFront distributions, two Next.js 16 builds
(the shop and the admin).

- **PPR (Partial Prerendering)** — static shell (header, footer,
  product images) renders at build time; dynamic islands (price,
  stock, cart count) render at request time.
- **ISR (Incremental Static Regeneration)** — product and category
  pages rebuild every 60 seconds in the background.
- **Server Components** — `getServerUser()` reads auth identity
  before first paint, avoiding the logged-in-flicker.

**Known constraint:** Amplify does NOT support on-demand revalidation
(`revalidateTag` / `revalidatePath`). Only time-based ISR works. This
is the single feature that would push us off Amplify if it became
critical; today it doesn't.

The frontend talks to the backend via **Hono RPC** — a typed-fetch
client generated from the Hono `AppType`. End-to-end TypeScript types
without a separate codegen step.

### 3.4 Backend — Hono on AWS Lambda

Three Lambda functions:

- **`shop-api`** — customer-facing. Product catalog, search, cart,
  orders, auth (8 endpoints across login/register/verify/reset/
  email-change), 14-day withdrawal, GDPR data export.
- **`admin-api`** — admin panel backend. Order/product/category/
  customer/discount CRUD, banner management, content versioning,
  backup orchestration.
- **`scheduler`** — three cron rules: daily catalog backup, hourly
  expired-pickup check, daily unverified-account cleanup.

All three are **Hono** — portable across Lambda, Workers, Bun, Deno,
and Node. **Drizzle** is the ORM. **`@hono/zod-openapi`** auto-
generates the OpenAPI 3.1 contract from the typed routes.

Authentication lives in `@shop/auth`:
- **Argon2id** with `m=19456, t=2, p=1` (the OWASP-recommended low-
  memory profile, RFC 9106 compliant)
- 32-byte CSPRNG session tokens, SHA-256-hashed at rest in
  `sessions.id_hash`
- Constant-time login (`argon2.verify` against `DUMMY_PASSWORD_HASH`
  for unknown emails)

Errors follow **RFC 9457 Problem Details**. Logs use **Pino with PII
redaction**, structured JSON, per-request child logger keyed on
`X-Request-Id`.

### 3.5 Database — Neon PostgreSQL

Neon is a managed Postgres that scales to zero (suspends after ~5
minutes idle; next query takes 300–800ms to wake). Schema today:
**30 tables, 32 FKs, 44 indexes, 10 enums**, all managed by Drizzle
migrations.

Design choices that are load-bearing:

- **Money as integer cents** via `numeric(10,0)` — never floats.
- **All timestamps `timestamptz`.**
- **UUIDs via `gen_random_uuid()`** — server-generated.
- **Soft delete via `deleted_at`**.
- **Optimistic locking** via `version` on orders.
- **`idempotency_key` UNIQUE** on orders — retries return the
  original order, never a duplicate.
- **Order line items snapshotted** at checkout — product name, code,
  image, unit price frozen onto each line so future catalog edits
  cannot rewrite history.

Connection pool: each Lambda container holds up to 3 connections,
initialised outside the handler so warm invocations reuse them. Neon
PgBouncer handles multiplexing on the database side.

**Tier today: Neon Free** (acceptable as SPOF caveat — see §6).
**Recommended for production: Neon Launch (~€18/mo, always-on,
7-day PITR, no auto-suspend cold start).**

### 3.6 Object storage — Amazon S3 (planned migration to R2)

S3 holds:
1. **Original product images** in a `temp/` prefix (deleted after
   processing).
2. **Three pre-optimised WebP variants** per image (1200×1200,
   400×400, 150×150 — about 2 MB per product total).
3. **Daily catalog backups** (full categories+products JSON snapshot
   with 90-day retention; >90 day backups move to Glacier).

CloudFront sits in front of the image bucket. Images are served
exclusively from edge cache.

**Sharp.js processes at UPLOAD time, not at request time.** Admin
uses an S3 presigned PUT URL (15-minute TTL, 10 MB cap, JPG/PNG only)
to bypass Lambda's 6 MB payload cap, then triggers
`POST /admin/process-image` to run Sharp.

**Planned migration to Cloudflare R2** for free egress and to
eliminate one AWS lock-in point. See §10.

### 3.7 Email — Amazon SES

SES has 8 transactional templates today: registration verification,
password reset, password changed, email change request/verify, order
confirmation, status update, withdrawal receipt + admin alert. All
Bulgarian, all rendered server-side by `@shop/email`.

Transport is an interface (`send(email)`) with three implementations:
`ses` (production, eu-central-1), `console` (dev), `stub` (tests).

**Critical: email sending is best-effort, never blocking.** A failed
verification email at registration time creates the account anyway
and tells the user to use "resend verification." Same for password
reset, email change, and the 14-day withdrawal receipt.

**The withdrawal-receipt case is the only real reliability gap.**
EU Directive 2023/2673 Art. 11a(2) requires the receipt as a
"durable medium" — an SES outage that drops the receipt is
technically a compliance problem. The fix is an SQS retry queue
between the Lambda creating the withdrawal record and the Lambda
sending emails. Deferred but real.

### 3.8 Background jobs — Amazon EventBridge Scheduler

Three cron rules:
- `0 3 * * *` Sofia — daily catalog backup to S3
- `0 * * * *` — hourly expired-pickup-deadline check
- `0 4 * * *` Sofia — daily unverified-account cleanup (>7 days old)

Cost: $0 (14M-invocation free tier).

### 3.9 Secrets — AWS Systems Manager Parameter Store

Holds: `NEON_DATABASE_URL`, `JWT_SECRET` (currently unused),
`SES_FROM_ADDRESS`, `ADMIN_MFA_CONFIG`. Read by Lambda at cold-start
via the AWS SDK. No hardcoded secrets anywhere.

Standard tier is free. The shop's needs fit comfortably in the
limits (10K parameters, 4 KB each).

### 3.10 Logs and alarms — Amazon CloudWatch

Every Lambda writes Pino JSON logs to a dedicated CloudWatch Log
Group with 30-day retention (recommend cut to 14 days — see §10).

Five alarms in the always-free 10-alarm tier:
- 5xx rate > 1% over 5 minutes → admin email
- Failed admin logins > 5/hour → admin email
- Lambda p99 duration > 5 seconds → admin email
- EventBridge scheduler failure → admin email
- SES bounce rate > 5% → admin email

**Gap:** no distributed tracing. The 2026 industry standard is
OpenTelemetry via AWS Distro for OpenTelemetry (ADOT). See §8.

### 3.11 Certificates — AWS Certificate Manager (ACM)

Free TLS certs, auto-renewed, attached to CloudFront. Zero
maintenance.

### 3.12 CI/CD — GitHub Actions

Five parallel jobs on every push:
1. `typecheck --workspaces --if-present`
2. `lint` (frontend)
3. `@shop/auth` tests
4. `@shop/email` tests
5. `@shop/api` tests

On `main` push: Amplify auto-deploys the two frontends; planned
GitHub Actions job runs `terraform apply` and
`aws lambda update-function-code`.

**Gaps:**
- No frontend `tsc --noEmit` in CI (cross-workspace type tangles).
- No branch protection enforcing the 5 checks.
- No SAST (CodeQL / Semgrep) — only SCA via Dependabot + `npm audit`.
- No SBOM generation (CycloneDX).
- No SLSA build provenance (Sigstore cosign).

These all become deal-breakers at OWASP Top 10 2025's new A03 line
(Software Supply Chain Failures). See §9.

---

## 4. The life of a request

Concrete walk-through. A customer named Иван places an order.

1. Browser → DNS → CloudFront IP.
2. CloudFront receives the GET, AWS WAF evaluates (no block), edge
   cache hits for the pre-rendered homepage (<50ms response).
3. Next.js hydrates on the client. `getServerUser()` already ran on
   the SSR pass and embedded "anonymous" into the response — no
   auth flicker.
4. Иван clicks a product. The product detail page is served from
   CloudFront (60s ISR cache). The "Add to cart" button is a client
   component.
5. He clicks Add. `POST /cart/items` to `shop-api.domain.bg`. WAF
   evaluates. Lambda warm-invokes (~10ms cold-start budget left
   from prior invocation). Hono routes to the cart handler. Drizzle
   runs `INSERT ... ON CONFLICT DO UPDATE` with `LEAST(qty+1, 99)`.
   Total wall-clock <100ms.
6. He registers. `POST /auth/register`. Argon2id hashes
   (~150ms — intentional). Verification token generated
   (`crypto.randomBytes(32)`) and stored SHA-256-hashed. SES
   accepts the email. He clicks the link, hits
   `POST /auth/verify-email`. Token hashed, looked up,
   `users.email_verified_at` set, cookie issued.
7. He checks out. UI generates an `Idempotency-Key` UUID, sends
   `POST /orders` with that header.
8. `shop-api` opens a Drizzle transaction:
   - `SELECT FOR UPDATE OF products` on the cart's products
   - re-check stock + prices
   - look up account discount
   - INSERT order header
   - INSERT line-item snapshots (frozen product name/code/image/
     unit-price per line)
   - seed status history
   - snapshot delivery address
   - clear the cart
9. Transaction commits. Two emails fire via `Promise.allSettled` —
   confirmation to Иван, admin alert. Best-effort. Failures logged
   but order stands.
10. He sees the success page. Order number formatted
    `2026-05-00042`.
11. Admin sees the new order in the dashboard.
12. Days later, admin marks the order "accepted." That starts the
    14-day withdrawal clock; `accepted_at` gets a timestamp.
13. An hour later, Иван decides to withdraw. He clicks "Откажете се
    от договора тук." Page POSTs to `/orders/:n/withdrawal`. Server
    inserts a `complaints` row (idempotently — partial unique
    index on `(order_id) WHERE reason='withdrawal'`). Two more
    emails fire.
14. A week passes. Иван never sees a cold-start, never gets logged
    out spuriously, never sees a 5xx page. The system is working.

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
| SQL injection | Drizzle parametrized queries everywhere | AWS WAF SQLi managed rules |
| Stored XSS | Next.js auto-escape + CSP nonces + `strict-dynamic` | AWS WAF Common managed rules |
| CSRF | `SameSite=Lax` + `__Host-` cookie prefix + same-origin API | None needed |
| Session hijack | `HttpOnly` + `Secure` + 32-byte CSPRNG + SHA-256-at-rest | TLS 1.3 + HSTS preload |
| Credential stuffing | Per-email 5-fail / 15-min lockout + Argon2id timing wall | WAF rate-limit rules on `/auth/login` |
| Account enumeration | Constant-time login + identical 400 for registration "email in use" + identical 200 for forgot-password | RFC 9457 errors (no internal-state leakage) |
| Email-link phishing | Single-use, 1-hour tokens, SHA-256-hashed at rest; password reset drops all sessions; out-of-band notification to old email at change time | None |
| DDoS L3/L4 | AWS Shield Standard (free) | None |
| DDoS L7 | WAF rate-limit rules + Lambda 1,000-concurrent ceiling | None |
| Stolen cookie | Drop-all-sessions on reset/email-change; orphaned-cookie cleanup on `/auth/me` | Idle timeout (2h without "Remember me") |
| Admin compromise | TOTP MFA mandatory + separate subdomain + stricter WAF | 30-min idle timeout, 5-fail 30-min lockout |
| Order replay | `Idempotency-Key` UNIQUE | None needed |
| Data-at-rest exfiltration | Neon encryption + S3 SSE | Tokens hashed; password hashes can't be reversed |
| Data-in-transit interception | TLS 1.3 + HSTS preload | CSP `upgrade-insecure-requests` |
| Supply-chain (malicious npm dep) | `package-lock.json` + Dependabot + `npm audit` in CI | None today — gap |
| Business logic abuse (price manipulation, discount escalation — OWASP 2025) | Server-side recalculation on every order | Account-discount is server-controlled, not client-supplied |

### 5.2 What this maps onto

OWASP Top 10 2025, full coverage matrix, lives in `COMPLIANCE.md`.
Quick summary:

- A01 Broken Access Control — ✅ (two-tier middleware)
- A02 Security Misconfiguration (newly #2) — ✅ mostly
- A03 Software Supply Chain Failures (expanded) — ⚠️ SCA yes, SBOM/SLSA no
- A04 Cryptographic Failures — ✅
- A05 Injection — ✅
- A06 Insecure Design — ✅ (idempotency, snapshots)
- A07 Authentication Failures — ✅ for admin, partial for customers (no MFA)
- A08 Software & Data Integrity Failures — ⚠️ no signed artifacts
- A09 Security Logging Failures — ⚠️ no distributed tracing, no CSP report
- A10 Mishandling Exceptional Conditions (new) — ✅ (RFC 9457 + graceful degradation)

### 5.3 Compliance touchpoints

Brief; full mapping in `COMPLIANCE.md`:

- **GDPR Art. 32** (security of processing): ✅ encryption + audit log
  + documented retention
- **GDPR Art. 17** (right to erasure): ✅ profile-page deletion flow
- **GDPR Art. 20** (data portability): ✅ JSON export
- **GDPR Art. 33–34** (breach notification 72h): ⚠️ no playbook
- **EU Directive 2023/2673** (14-day withdrawal): ✅ shipped
- **WCAG 2.2 Level AA / European Accessibility Act**: ✅ in scope
- **PCI-DSS**: n/a
- **NIS2**: n/a at current scale
- **EU CRA**: 24h vulnerability-reporting deadline Sept 11, 2026 —
  technically targets products not SaaS, but adopting CRA-style
  hygiene (SBOM, vuln disclosure policy) is becoming baseline

---

## 6. Reliability model

### 6.1 Failure modes

| Failure | What the system does | What you do |
|---|---|---|
| Lambda cold start | One-off ~500ms latency | Nothing |
| Lambda crash | 500 returned; Pino logs; alarm if >1% in 5min | Read log, ship fix |
| Neon auto-suspend (Free) | First query 300–800ms wakeup | Upgrade to Launch in prod |
| Neon outage (Free/Launch) | DB calls fail; `currentUser` deliberately does NOT clear cookies on DB errors; WAF + alarm + email | Wait or upgrade to Scale |
| Neon outage (Scale) | Automatic failover, sub-10s impact | Nothing — that's what you pay for |
| SES outage | Email failures logged; account/order ops still complete | Manually re-trigger after recovery; long-term fix is SQS retry |
| CloudFront degradation | Edge misses fall through to multi-AZ origin | Nothing — AWS handles |
| Amplify build failure | Atomic deploy: old version stays live | Fix and redeploy |
| Mass session compromise | `UPDATE sessions SET revoked_at=now()` via `db:psql` | Force server-side invalidation, notify customers |
| Logical data loss (DROP TABLE) | Neon PITR rolls back (7d on Launch, 30d on Scale) | Use Neon branch-and-restore |
| Catalog mistake (admin deletes category) | Daily S3 backup + admin-UI restore flow | Use admin "Restore from backup" |
| AWS regional outage | Hard down — no multi-region today | Wait (Milestone 4) |

### 6.2 RTO / RPO targets

These are not yet formalised in code or alarms. They should be:

**At Neon Launch (recommended production posture):**
- RTO 1 hour
- RPO 5 minutes

**At Neon Scale (contractual-SLA posture):**
- RTO 5 minutes (automatic failover)
- RPO 1 minute (continuous replication)

### 6.3 Backup discipline

- **Daily catalog backup** at 03:00 Sofia, S3 versioned, 90-day
  retention, >90d moves to Glacier Instant Retrieval.
- **Neon PITR** is continuous — 7 days on Launch, 30 days on Scale.
- **DR drill cadence:** none today. Recommended quarterly. See §12.

---

## 7. Performance model

### 7.1 Targets (Core Web Vitals)

| Metric | Target | Status |
|---|---|---|
| LCP (Largest Contentful Paint) | <2.5s | Achievable today |
| INP (Interaction to Next Paint) | <200ms | Achievable today |
| CLS (Cumulative Layout Shift) | <0.1 | Achievable today |

These are aspirational; they are not currently measured continuously.
Gap: no Lighthouse CI / WebPageTest synthetic monitoring.

### 7.2 Service-level targets (proposed)

These do not yet exist in the project. Recommend adopting them:

| SLI | SLO | Window | Error budget |
|---|---|---|---|
| Availability (shop-api 2xx+3xx of total) | 99.9% | 30 days | 43 min/mo |
| Availability (admin-api) | 99.5% | 30 days | 3.6 hr/mo |
| p95 latency (shop-api) | <200ms | 30 days | n/a |
| p95 latency (search autocomplete) | <100ms | 30 days | n/a |
| Order placement success rate | 99.95% | 30 days | 15 min/mo of placement failures |

Google's SRE error-budget policy:
- **Green** (>50% budget remaining) — ship features at normal velocity
- **Yellow** (20–50%) — reduce deployment frequency
- **Orange** (1–20%) — freeze non-critical deployments
- **Red** (0%) — feature freeze, reliability-only changes

Stored in `OpenSLO` YAML files alongside source code is the 2026
best practice.

### 7.3 Connection pooling

Each Lambda container: 3-connection pool, opened outside the handler.
Neon PgBouncer (transaction-pooled) handles up to 10,000 concurrent
client connections on the database side. Lambda can scale to 1,000
concurrent invocations without exhausting it.

---

## 8. Observability model

### 8.1 Current state

- **Structured Pino logs** with PII redaction, per-request child
  logger keyed on `X-Request-Id`.
- **CloudWatch Logs** with 30-day retention.
- **5 CloudWatch alarms** in the always-free tier.
- **AWS X-Ray** is not enabled. (Was originally treated as optional in
  the infrastructure design; in 2026 that is a real gap — see §8.2.)

### 8.2 Target state (2026 industry standard)

The 2026 default for serverless observability is **OpenTelemetry**
via **AWS Distro for OpenTelemetry (ADOT)**:

- Distributed tracing across `Amplify → shop-api → Neon → SES` so
  you can see a single request's whole life as one trace.
- Standardised semantic conventions (HTTP, database, FaaS, messaging
  per OpenTelemetry semconv 1.41.0, all production-stable).
- Backend of choice (CloudWatch X-Ray, Grafana Tempo, Honeycomb,
  Datadog, etc.) — ADOT makes the backend swappable.

**Effort to add:** 1 day. ADOT ships as a Lambda layer; the
instrumentation libraries auto-instrument the AWS SDK + HTTP +
`pg` + Hono with one config change.

### 8.3 Metrics that should exist but don't

- **DORA metrics**: deployment frequency, lead time for changes,
  MTTR, change failure rate. Solo project so MTTR is "however long
  it takes you to wake up," but the discipline of measuring matters
  the moment a second contributor lands.
- **Custom business metrics**: orders/hour, conversion-rate by
  funnel stage, withdrawal-rate. Currently none.
- **RUM (Real User Monitoring)**: actual user Core Web Vitals from
  browsers. Cloudflare Web Analytics (free), Vercel Analytics
  (Hobby restriction), or self-hosted Plausible/Umami are all
  options.

### 8.4 Alarm-rule maturity

Five alarms is a good starting set. For A+:

- **Burn-rate alerting** on the proposed SLOs above (page when 4×
  burn over 1 hour, escalate when 2× over 6 hours).
- **Status page** (statup.fyi free, or self-hosted) for transparent
  external communication during incidents.
- **CSP violation report endpoint** — currently CSP is set with
  `strict-dynamic` and nonces but no `report-to` directive,
  meaning XSS attempts the CSP defeats are invisible. A simple
  endpoint at `/api/csp-report` writing into CloudWatch closes that
  loop.

---

## 9. Supply-chain security

This is where the architecture most clearly falls short of 2026
production-grade.

### 9.1 What exists today

- `package-lock.json` committed, reproducible installs.
- Dependabot alerts enabled (GitHub free).
- `npm audit` runs in CI on every PR.
- Single `package.json` per workspace, no spurious globally-installed
  tools at build time.

That covers **Software Composition Analysis (SCA)** — third-party
vulnerability detection. It does NOT cover any of:

### 9.2 What's missing

| Practice | Gap | Effort | Standard |
|---|---|---|---|
| **SAST** (static analysis of first-party code) | None | 1 hour | OWASP ASVS V10, OWASP Top 10 2025 A03 |
| **SBOM** (Software Bill of Materials) | None | 2 hours | EU CRA Sep 2026 deadline, NIST CSF 2.0 Identify, NTIA |
| **Build provenance** (SLSA L2) | Currently SLSA L0 (no provenance) | ~1 day | SLSA v1.1 spec |
| **Artifact signing** (Sigstore cosign) | None | ~1 day | SLSA L2 requirement |
| **Branch protection on `main`** | None | 5 minutes | Basic SDLC |
| **Signed commits** | None | 1 hour to configure | Optional but rising |
| **Vulnerability disclosure policy** (`security.txt`) | None | 15 minutes | RFC 9116 |

### 9.3 SLSA target

**Current level: SLSA 0** (no provenance generated).

**Target: SLSA Level 2** — provenance is produced by a hosted build
platform (GitHub Actions) and digitally signed (Sigstore cosign via
keyless OIDC).

Path:
1. Add `cyclonedx/gh-node-module-generatebom` action to CI → emits
   CycloneDX SBOM per workspace per build.
2. Add `sigstore/cosign-installer` action → sign the SBOMs + Lambda
   ZIPs using GitHub Actions' OIDC token (no long-lived keys
   needed).
3. Store signed provenance as a GitHub release asset.
4. Document the verification procedure in `RUNBOOK.md` (or here).

That puts the project at SLSA Level 2. Level 3 requires
non-falsifiable build infrastructure (hardened runners, isolated
build secrets) — overkill for current scale.

### 9.4 Static analysis (SAST)

Recommended: **GitHub CodeQL** (free for public repos) OR
**Semgrep** (free Cloud tier, OSS rules included). CodeQL has
better coverage for cross-function data-flow; Semgrep is faster
and easier to author custom rules for.

For TypeScript codebases the default CodeQL ruleset catches:
- Reflected XSS (relevant to admin panel inputs)
- SQL injection (defeated by Drizzle but worth confirming)
- Insecure deserialization
- Path traversal in file uploads
- Hardcoded credentials

One day of work, including triaging the first scan's findings.

---

## 10. Cost model

### 10.1 Today's pricing

| Tier | PV/mo | Cost (Neon Free) | Cost (Neon Launch) |
|---|---|---|---|
| 0 — Idle | 0 | €6.90 | €24.62 |
| 1 — Start | 2K | €6.92 | €24.64 |
| 2 — Small | 20K | €7.10 | €24.83 |
| 3 — Growth | 100K | €7.92 ⚠️ | €25.64 |
| 4 — Busy | 400K | n/a | €28.64 |
| 5 — Big | 2M | n/a | €70.00 |

**Decomposition of the Tier 4 (€28.64) bill:** Neon Launch is 62%
($19.26); AWS WAF + Route 53 is 34% ($10.60 between fixed + per-
request); everything else (CloudFront, Lambda, Amplify SSR, S3) is
free at this scale.

### 10.2 Recommended swap: Cloudflare edge

The single biggest unforced overpayment is **AWS WAF + Route 53**.
Cloudflare's Free tier provides:
- Unmetered L3/L4/L7 DDoS protection (stronger than AWS Shield
  Standard)
- Free TLS certs
- Free DNS
- Cloudflare-managed Free WAF ruleset (basic but real)
- Bot Fight Mode (blocks scrapers / credential stuffers)
- Unlimited CDN bandwidth for static assets
- HTTP/3 / QUIC

Migration paths:

**A1 — DNS-only + R2 for images.** Half a day. Saves €0.50/mo.
Eliminates two AWS lock-in points. **No-regret. Do this first.**

**A2 — Cloudflare Free proxy (also replaces WAF).** One day. Saves
€7–10/mo at Tier 0–3, €10/mo at Tier 4, €42/mo at Tier 5. The
trade-off is Cloudflare Free's narrower managed WAF rule coverage
(no OWASP CRS, no custom rules) — defensible for this shop's threat
model (no PAN data, strong app-layer defences) while still small,
**upgrade to A3 as soon as you're attracting real traffic.**

**A3 — Cloudflare Pro proxy ($25/mo).** Strictly stronger security
than the current AWS setup: full Cloudflare Managed Ruleset + OWASP
CRS + 5 custom WAF rules + 5 rate-limit rules + image polish + ML
bot scoring + Page Shield (CSP enforcement at edge). Costs €13–16/
mo more than today at Tier 0–4, **€19/mo less at Tier 5.** Pays
back at scale.

### 10.3 Recommended tier table (after A1+A2)

| Tier | Products | Visitors/mo | PV/mo | Orders/mo | Cost |
|---|---|---|---|---|---|
| 0 — Idle | 0 | 0 | 0 | 0 | **€0/mo** |
| 1 — Start | 50 | 500 | 2K | 10 | **€0/mo** |
| 2 — Small | 250 | 5,000 | 20K | 100 | **€18/mo** (Neon Launch starts) |
| 3 — Growth | 1,000 | 25,000 | 100K | 500 | **€18/mo** |
| 4 — Busy | 3,000 | 100,000 | 400K | 2,000 | **€19/mo** |
| 5 — Big | 5,000+ | 500,000 | 2M | 10,000 | **€28/mo** |

If on A3 instead, add ~€23/mo flat (which becomes a saving at
Tier 5).

### 10.4 Other cost optimisations

- **CloudWatch Logs retention** — cut from 30 to 14 days. Saves
  $0–7/mo depending on log volume.
- **Cost alerts via AWS Budgets** at $30/mo — already done per
  EU-wide ambition or an explicit second-region requirement.
- **AWS Customer Carbon Footprint Tool** — quarterly review;
  documents the Sustainability pillar.

---

## 11. Day-to-day operations

### Daily (automated)

- 03:00 Sofia — catalog backup runs
- Hourly — expired-pickup-deadline check
- 04:00 Sofia — unverified accounts older than 7 days deleted
- Continuous — CloudWatch alarms watch 5xx, admin logins, Lambda
  duration, SES bounces

### Weekly (5–10 min)

- Glance at AWS Budgets dashboard
- Review Dependabot PRs, merge green ones

### Monthly (~30 min)

- CloudWatch Logs Insights query for 4xx/5xx patterns
- Check Neon usage dashboard — Free plan CU-hour ceiling, Launch
  cost trajectory
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
- Re-run a Well-Architected Review using AWS' tool (free,
  self-service)

### On-incident triage order

1. Is it the database? `db:psql`; `SELECT 1`; check `status.neon.tech`
2. Specific Lambda? CloudWatch Logs → filter by `X-Request-Id`
3. Frontend? Amplify build history
4. Edge? CloudFront status, WAF rule firing rate
5. Email? SES Console reputation tab

Document every incident — even 5-minute ones. The first incident
with no postmortem is the start of a culture of forgetting.

---

## 12. Disaster recovery

### 12.1 What can be lost

- **Database** — recoverable to any point in the last 7d (Launch)
  or 30d (Scale) via Neon PITR.
- **Catalog structure** — recoverable from daily S3 backup
  (90 days, then Glacier).
- **Customer accounts and orders** — recoverable from Neon PITR.
  No daily catalog backup contains them (intentional — orders are
  considered transactional, not structural).
- **Order line snapshots** — frozen onto each order row at
  checkout. Survive any catalog edit or restore.

### 12.2 Procedure (Neon PITR)

```
1. Identify target timestamp (e.g., "10 minutes before the bad migration").
2. In Neon console: create a new branch from PITR at that timestamp.
3. Run a verification query — confirm row counts, sample data.
4. Switch NEON_DATABASE_URL in SSM Parameter Store to the new branch.
5. Redeploy Lambdas (so they pick up the new env var).
6. Verify a few requests against the live shop.
7. (Optional) Promote the new branch to "main" in Neon, archive old.
```

Run this drill quarterly. Document each run in `RUNBOOK.md` (or
this section). The first run with no rehearsal is the wrong time to
discover that step 4 takes 20 minutes longer than you expected.

### 12.3 Procedure (catalog restore from S3 backup)

```
1. Admin panel → Archive → Choose a date → Preview → Restore
2. Confirm warning ("This overwrites current categories and
   products; orders are unaffected")
3. Click Confirm
4. Watch the audit log entry appear
```

Tested every time a backup is taken (the system runs a checksum
verification on the JSON immediately after upload).

---

## 13. Architecture decisions locked in

These are baked-in for good reasons; revisiting them costs you
weeks. Don't re-litigate without a strong new constraint:

- **Drizzle, not Prisma** — Lambda bundling + raw-SQL escape hatches.
- **Money as integer cents** — float arithmetic loses money.
- **`timestamptz` always** — naïve timestamps are a bug magnet.
- **Neon, not RDS** — RDS forces a VPC which adds NAT Gateway
  ($32/mo) and slows Lambda cold-starts by 300–500ms.
- **Hono on Lambda** — same handler runs on Workers/Bun/Node, so
  the deployment target can change without rewriting the API.
- **Zod 4 + `@hono/zod-openapi`** — the API contract is the code.
- **RFC 9457 Problem Details** — every error has a consistent shape.
- **Cursor (keyset) pagination** — offset pagination is O(n).
- **`__Host-`-prefixed cookies in prod** — the prefix forbids
  unsecure transmission, cross-domain leaks, and HttpOnly bypass.
- **Argon2id `m=19456, t=2, p=1`** — RFC 9106 + OWASP 2024 low-
  memory recommended profile.
- **32-byte CSPRNG session tokens, SHA-256-hashed at rest**.
- **Constant-time login** — defeats email enumeration via timing.
- **Per-email brute-force lockout, not per-IP** — IP-based lockout
  is bypassable from one mobile-tether reconnect.
- **Two-tier auth middleware** (`currentUser` best-effort + `requireAuth`
  gate) — anonymous-and-authenticated routes share paths.
- **Orphaned-cookie cleanup in `currentUser`** — prevents the
  `/login → /profile → /login` redirect loop.
- **CORS with credentials, allowlist origins** — wildcard +
  credentials is rejected by browsers.
- **Two-mode cart** (sessionStorage guest, server-persisted user) —
  matches the industry pattern; merge endpoint sums on login.
- **Order line items snapshotted** — historical orders survive
  catalog edits.
- **`Idempotency-Key` UNIQUE on orders** — the partial unique
  index IS the idempotency boundary; no separate Redis needed.
- **`accepted_at` is the canonical withdrawal-window start**.
- **Best-effort email sends** — registration / reset / withdrawal
  never roll back on email failure.
- **Single admin account** — multi-admin is out of scope.

---

## 14. Honest assessment vs A+ target

**Current state, scored against AWS Well-Architected:**

| Pillar | Today | What's missing for A+ |
|---|---|---|
| Operational Excellence | B+ | Distributed tracing (OpenTelemetry/ADOT), formal SLOs + burn-rate alerting, DORA metrics, scheduled DR drills, incident postmortem template, status page |
| Security | A− | SAST, SBOM, SLSA L2 signing, CSP violation reporting, HIBP breach check, customer MFA option, security.txt, branch protection |
| Reliability | B | Formal RTO/RPO, SQS retry queue for SES, DR drill cadence, public status page |
| Performance Efficiency | B+ | Synthetic monitoring (Lighthouse CI), RUM, query-latency SLOs per endpoint, additional image variants (800px, 2000px) |
| Cost Optimization | B− | Cloudflare swap (the big one), CloudWatch retention to 14d |
| Sustainability | A | Documented quarterly AWS CFT review |

**Cross-checked against 2026 industry standards beyond AWS WA:**

| Standard | Status | What's needed |
|---|---|---|
| NIST CSF 2.0 (Govern function) | ⚠️ Partial | Risk register, supply-chain policy doc, vulnerability disclosure policy |
| NIST CSF 2.0 (Detect function) | ⚠️ Partial | Distributed tracing |
| NIST CSF 2.0 (Respond function) | ⚠️ Partial | Incident playbook |
| OWASP Top 10 2025 — A03 Supply Chain | ⚠️ Partial | SBOM + SLSA L2 |
| OWASP Top 10 2025 — A08 Integrity Failures | ❌ | Signed artifacts |
| OWASP Top 10 2025 — A09 Logging Failures | ⚠️ | Distributed tracing + CSP reports |
| OWASP ASVS 6.0 L1 | ✅ Compliant | — |
| OWASP ASVS 6.0 L2 | ⚠️ Gaps | Customer MFA + SAST |
| NIST SP 800-63B-4 | ⚠️ Minor | Replace composition password rules with length + HIBP |
| NIST SP 800-207 (Zero Trust) | ✅ Spirit | Already verifying every request; per-Lambda least-privilege IAM; no implicit subdomain trust |
| SLSA v1.1 | Level 0 → Target L2 | Add CycloneDX SBOM + Sigstore cosign |
| CIS Controls v8.1 IG1 | ✅ Mostly | Add asset inventory doc + vuln disclosure |
| GDPR Art. 32 / 17 / 20 | ✅ | — |
| GDPR Art. 33–34 (72h breach) | ⚠️ | Playbook |
| EU Directive 2023/2673 | ✅ Shipped | — |
| EU CRA (Sep 2026 vuln reporting) | ⚠️ Debatable scope, adopt anyway | SBOM + disclosure process |
| WCAG 2.2 AA | ✅ In scope | Continuous audit |

**Verdict.** The architecture is meaningfully above 2026 industry
median for a B2C shop of this profile. It exceeds typical
standards in auth security, idempotency discipline, and structured
logging. Reaching genuine A+ across the board needs roughly 4 days
of focused work — concrete roadmap in §15.

A side note on the "no compromise" framing the user asked for:
there's no such thing in software architecture. Every choice trades
something. What CAN exist is "no UNJUSTIFIED compromise" — every
trade-off is explicit, intentional, and documented. The roadmap
below gets the project to that state.

---

## 15. Roadmap to A+

Ranked by `(impact ÷ effort)` — highest leverage first.

### Week 1 — supply-chain hardening (1 day total)

1. **Branch protection on `main`** (5 min)
   - GitHub Settings → Branches → require 5 CI checks before merge.
2. **Add `.well-known/security.txt`** (15 min)
   - RFC 9116. Static file with a `Contact: security@domain.bg`
     line plus a 1-year `Expires:` field.
3. **Add CodeQL SAST to CI** (1 hour)
   - `github/codeql-action/init@v3` + `analyze@v3`. Default
     TypeScript ruleset.
   - Triage the first scan's findings — usually <10 alerts.
4. **Add CycloneDX SBOM to CI** (2 hours)
   - `CycloneDX/gh-node-module-generatebom@v1` per workspace.
   - Publish SBOMs as GitHub release assets.
5. **Add Sigstore cosign keyless signing** (3 hours)
   - `sigstore/cosign-installer@v3` action.
   - Sign each SBOM + each Lambda ZIP using GitHub OIDC.
   - Achieves SLSA Level 2.

### Week 1 — observability (1 day total)

6. **Add AWS Distro for OpenTelemetry to the three Lambdas** (1 day)
   - ADOT Lambda layer + `OPENTELEMETRY_*` env vars.
   - Choose backend: CloudWatch X-Ray (zero new vendor) or
     Honeycomb / Grafana Tempo (better UX, free tier).
   - Verify distributed traces show `shop-api → Neon → SES`.

### Week 2 — reliability (1 day total)

7. **Add SQS retry queue between Lambda and SES** (4 hours)
   - SQS standard queue + DLQ. Lambda enqueues; a second Lambda
     consumer drains and calls SES with exponential backoff. Closes
     the withdrawal-receipt durable-medium gap.
8. **Formalise SLOs in `slos.yaml` (OpenSLO format)** (1 hour)
   - Versioned, reviewed, in Git.
9. **Add burn-rate alarms** (1 hour)
   - CloudWatch composite alarms on the SLOs.
10. **Schedule the first DR drill** (2 hours including doc)
    - Calendar reminder, drill script, written outcome.

### Week 2 — cost (1 day total)

11. **Path A1: DNS to Cloudflare + S3 images → R2** (½ day)
    - Saves €0.50/mo, eliminates two AWS lock-in points.
12. **Cut CloudWatch Logs retention to 14 days** (5 min)
    - Console toggle.
13. **Decide A2 vs A3** (decision, not work) — Cloudflare Free
    proxy now (saves money) OR Cloudflare Pro proxy (stronger
    security, slight cost increase that pays back at Tier 5).

### Week 3 — security depth (1 day total)

14. **Add CSP violation report endpoint** (2 hours)
    - `POST /api/csp-report` that writes the report into CloudWatch.
    - Add `report-to` directive to the CSP header.
15. **Add HIBP k-anonymity check on registration / password reset**
    (2 hours)
    - One HTTP call to `api.pwnedpasswords.com`. Block top-100K
      breached passwords.
16. **Add a `THREAT_MODEL.md`** (2 hours)
    - STRIDE pass over each major data flow. Document mitigations.
17. **Move customer password rules from composition to length-only**
    (2 hours, requires UX coordination)
    - NIST SP 800-63B-4 deprecates composition rules.

### Month 2 — performance + governance (3 days total)

18. **Lighthouse CI on every PR** (4 hours)
    - GitHub Action, perf budget thresholds, fails the build on
      regression.
19. **Add Real User Monitoring (RUM)** (2 hours)
    - Cloudflare Web Analytics (free, no cookie) or Plausible (€9/mo
      self-hosted).
20. **Status page** (1 hour)
    - statup.fyi or self-host. Manually update on incidents.
21. **Document the incident playbook** (3 hours)
    - Postmortem template, severity definitions, communication
      template.
22. **Asset inventory document** (2 hours)
    - All AWS resources, Neon project, GitHub repo, domain
      registrar, MFA seed locations.
23. **Vulnerability disclosure policy page** (1 hour)
    - Public `/security` page with disclosure process.

### Quarter 2+ — growth-stage upgrades

24. **Customer MFA option** (~3 days) — moves ASVS to L2 compliance.
25. **Multi-region failover** (~1 week) — Milestone 4 from
    (originally Milestone 4 in the historical infra spec). Defer
    until a customer requires a contractual SLA.
26. **Move to Neon Scale** when contractual SLA is required.
27. **Upgrade SLSA to Level 3** — only if you need build-platform-
    enforced isolation.

**Doing items 1–13 closes every meaningful 2026 gap in ~4
working days. Items 14–23 raise the quality bar further at ~3
more days. Items 24+ are growth-stage; not blocking on A+.**

---

## 16. Glossary

Briefly, every acronym in this document and its siblings:

- **ACM** — AWS Certificate Manager. Free TLS certs.
- **ADOT** — AWS Distro for OpenTelemetry.
- **Argon2id** — modern password hashing function, OWASP and RFC
  9106 standard.
- **ASVS** — OWASP Application Security Verification Standard.
  L1 = baseline; L2 = sensitive data; L3 = high-assurance.
- **CIS Controls** — Center for Internet Security's 18-control
  framework. IG1 (Implementation Group 1) = small business baseline.
- **Cold start** — first invocation of a Lambda function after idle.
- **Cosign** — Sigstore's code-signing CLI.
- **CRA** — EU Cyber Resilience Act. Sept 11, 2026 deadline for
  24-hour vulnerability reporting.
- **CSF** — NIST Cybersecurity Framework. Version 2.0 (2024) has
  6 functions: Govern, Identify, Protect, Detect, Respond, Recover.
- **CSP** — Content Security Policy.
- **CSPRNG** — Cryptographically Secure Pseudo-Random Number
  Generator.
- **CSRF** — Cross-Site Request Forgery.
- **CU / CU-hour** — Neon Compute Unit. 1 CU = 1 vCPU + 4 GB RAM.
- **CWE** — Common Weakness Enumeration.
- **CycloneDX** — OWASP-hosted SBOM format. Alternative: SPDX.
- **DORA** — DevOps Research and Assessment. The 4 metrics
  (deployment frequency, lead time, MTTR, change failure rate).
- **DSAR** — Data Subject Access Request.
- **ETag** — HTTP cache validator.
- **Fulcio** — Sigstore's certificate authority for keyless signing.
- **HIBP** — Have I Been Pwned. Free k-anonymity API for password
  breach checking.
- **HSTS** — HTTP Strict Transport Security.
- **IAM** — AWS Identity and Access Management.
- **IG1** — CIS Controls Implementation Group 1.
- **ISR** — Incremental Static Regeneration (Next.js).
- **MFA** — Multi-Factor Authentication.
- **NIS2** — EU directive on cybersecurity. Applies to "important
  entities."
- **OIDC** — OpenID Connect (used by Sigstore for keyless signing).
- **OpenSLO** — YAML format for declarative SLO definitions.
- **OpenTelemetry / OTel** — vendor-neutral standard for traces,
  metrics, logs.
- **OWASP Top 10** — most critical web vulnerabilities. 2025 edition
  is current.
- **PCI-DSS** — Payment Card Industry Data Security Standard.
  Not in scope (no PAN storage).
- **PgBouncer** — Postgres connection pooler.
- **PII** — Personally Identifiable Information.
- **PITR** — Point-in-Time Recovery (Neon: 7d Launch, 30d Scale).
- **PPR** — Partial Prerendering (Next.js 16).
- **Rekor** — Sigstore's transparency log.
- **RPO** — Recovery Point Objective. Max acceptable data loss.
- **RTO** — Recovery Time Objective. Max acceptable downtime.
- **RUM** — Real User Monitoring (browser-side perf collection).
- **SAST** — Static Application Security Testing.
- **SBOM** — Software Bill of Materials.
- **SCA** — Software Composition Analysis (deps).
- **SES** — AWS Simple Email Service.
- **SLI / SLO / SLA** — Indicator (measurement) / Objective (target)
  / Agreement (contract).
- **SLSA** — Supply-chain Levels for Software Artifacts. Levels 0–3.
- **SPOF** — Single Point Of Failure.
- **SQS** — AWS Simple Queue Service.
- **SRE** — Site Reliability Engineering.
- **SSM Parameter Store** — AWS Systems Manager Parameter Store.
- **STRIDE** — Spoofing / Tampering / Repudiation / Information-
  disclosure / Denial-of-service / Elevation-of-privilege. A threat-
  modelling taxonomy.
- **TOTP** — Time-based One-Time Password (Google Authenticator).
- **WAF** — Web Application Firewall.
- **WAL** — Postgres Write-Ahead Log.
- **WCAG** — Web Content Accessibility Guidelines. 2.2 AA is the
  European Accessibility Act baseline.
- **ZTA** — Zero Trust Architecture (NIST SP 800-207).

---

*This is the single technical doc. For the auditor-facing
standards-by-standards matrix, see `COMPLIANCE.md`. For the
functional / product specification, see `docs/README.md`
(Bulgarian).*
