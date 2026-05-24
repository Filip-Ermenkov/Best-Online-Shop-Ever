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
> Last updated: 2026-05-24.

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
  orders, auth (10 endpoints across login/register/verify/reset/
  email-change/change-password/profile-update), 14-day withdrawal,
  GDPR data export.
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
- **NIST SP 800-63B Rev. 4** password policy (shipped May 2026):
  ≥12 chars, ≤1024 chars, no composition rules, screened against
  the Have I Been Pwned breach corpus at registration, password
  reset, AND authenticated password change via the k-anonymity API.
  HIBP failure-mode is open (a warning log, not a hard block) — we
  don't couple signup availability to a single-vendor free service.
  Login is NOT gated by the HIBP check, so existing customers
  cannot be locked out retroactively if their once-acceptable
  password later turns up in a breach. See §5.2 below.
- **Authenticated password change** (shipped May 2026): `POST
  /auth/change-password`. Requires the current password as re-auth
  proof (defeats the walked-away-from-shared-computer threat per
  OWASP Authentication Cheat Sheet "Change Password Feature").
  Closes OWASP ASVS V6.2 / NIST SP 800-63B-4 §5.1.1.2 ("subscribers
  SHALL be able to change their memorized secret"). On success the
  hash rotates, every OTHER session for the user is dropped, the
  initiating session is preserved (industry convention — the
  device just proved it knows the current password, so logging it
  out would be pure churn), and a best-effort notification email
  fires to the account address. The current-password verify shares
  the same per-email lockout counter as `/auth/login`, so a
  stolen-cookie attacker cannot brute-force the password through
  this endpoint without tripping the same 5-fails-in-15-min cap.

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
| Stored XSS | Next.js auto-escape + uniform strict CSP (`'nonce-X' 'strict-dynamic'`, see §5.2) + Hono `secureHeaders` on the API | AWS WAF Common managed rules |
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

### 5.2 Content Security Policy

The May 2026 CSP slice shipped *twice* before landing on the right
design. The first attempt missed a subtle property of single-page
applications; the second attempt corrects it. This section
documents the corrected design and notes the rejected approach so
the reasoning isn't relearned the hard way.

**Two-and-a-half facts about CSP in Next.js 16.**

1. A document's `Content-Security-Policy` is **fixed at HTML
   document load**. There is no specified way to change it on a
   running document. Soft navigation in an SPA reuses the
   document, so the CSP that applied at first load applies to
   every subsequent route the user navigates to via `<Link>`.
2. Next.js 16's official guide is explicit that **nonce-based CSP
   requires dynamic rendering**. Static / ISR / PPR pages are
   generated at build time when there is no request, so no nonce
   can be injected — a nonce-based CSP would block the page's own
   framework scripts.
3. The shop's root layout reads cookies via `getServerUser()` to
   bootstrap auth identity without flicker. Reading cookies forces
   dynamic rendering. **Every route in this app is therefore
   already dynamic.** The "ISR for catalog pages" claim in earlier
   revisions of this doc was technically inaccurate.

**The rejected hybrid design (May 16, 2026).** The first shipped
revision applied a strict nonce-based CSP only to `/account/*` and
`/admin/*` via the proxy, and a permissive `'unsafe-inline'`
baseline to the catalog via `next.config.ts`. This works correctly
on hard navigations — both `curl` and direct URL entry show the
intended policy per route. But because the catalog uses `<Link>`
to route into the account section, a typical user wanders
`/ → /products/123 → /account/login` via soft navigation. The
document's CSP never changes after that first load on `/`, so
inline-script protection on `/account/login` was silently bypassed
in the most common traffic pattern. A `document.createElement('script')`
test from the DevTools console confirmed this — the script
executed on `/account/login` because the document still carried
`/`'s permissive CSP.

**The shipped design (May 19, 2026).** A single uniform strict
CSP applied to every HTML document via `frontend/src/proxy.ts`.
The proxy now matches every route (excluding only Next.js
internals, `/api`, `/.well-known/`, and prefetch requests, per
the matcher in the file), and on every request:

1. Generates a 128-bit random nonce via
   `Buffer.from(crypto.randomUUID()).toString('base64')` — the
   pattern from the Next.js 16 official CSP guide.
2. Sets a forwarded `x-nonce` request header so any Server
   Component that needs to attach a nonce to `<Script>` can read
   it via `await headers()`.
3. Sets a response `Content-Security-Policy` header:

   ```
   default-src 'self';
   script-src 'self' 'nonce-XXX' 'strict-dynamic';
   style-src 'self' 'nonce-XXX';
   img-src 'self' blob: data: https://cdn.duda1.bg;
   font-src 'self' data:;
   connect-src 'self' https://shop-api.duda1.bg;
   object-src 'none';
   base-uri 'self';
   form-action 'self';
   frame-ancestors 'none';
   upgrade-insecure-requests;
   ```

`'strict-dynamic'` means: a script that carries the matching nonce
is trusted to load further scripts; nothing else loads, period.
`'self'`, `'unsafe-inline'`, and `https:` allow-list entries are
all ignored in its presence per CSP3 — that's the point. Next.js
auto-attaches the nonce to framework and page-bundle scripts when
it sees the CSP header on the request (see Next.js CSP guide §"How
nonces work in Next.js"). In `NODE_ENV=development`, the policy
adds `'unsafe-eval'` to script-src and `'unsafe-inline'` to
style-src because React debugging and HMR depend on both — these
are gated on dev only and never emitted in production.

**Why uniform-strict isn't expensive here.** Because every route
is already dynamic (point 3 above), there is no ISR / PPR cache
benefit being thrown away. Every render goes through Lambda SSR
regardless. The proxy adds a UUID generation, three header
operations, and ~1 ms per request. At Tier 5 (2M PV/mo) the
cumulative cost is roughly $0.10 of Lambda time per month. Free.

**The soft-navigation trap that motivated the rewrite is now
neutralised.** Every document the user can land on (catalog or
account) ships with the same strict policy. Clicking a `<Link>`
between them doesn't cross a security boundary because both sides
*are* the boundary.

#### 5.2.1 Baseline security headers on every response

`frontend/next.config.ts` continues to set the rest of the
security-header set via `headers()`. CSP is intentionally **not**
set here — that would re-create the hybrid pattern this section
rejects. The headers `next.config.ts` does set:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy:` — empty allow-list for every browser
  feature the shop doesn't use (camera, mic, geolocation, payment,
  browsing-topics, interest-cohort, USB, sensors, ...)
- `X-Frame-Options: DENY` (redundant with `frame-ancestors 'none'`
  but covers ancient browsers that don't honour CSP3)
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-site`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  (production builds only — pinning HSTS on http://localhost
  forces the browser to refuse plain HTTP to localhost for
  max-age seconds, a nasty dev footgun)

#### 5.2.2 The Hono API gets its own (stricter) CSP

`backend/shop-api/src/app.ts` wires `hono/secure-headers` with the
strictest possible policy for a JSON-only endpoint:

```
default-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'none';
```

Plus `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
same-site` (allows the legitimate `shop.duda1.bg → shop-api.duda1.bg`
cross-subdomain fetch but blocks unrelated origins from `<img src>`
or `<script src>` of an API response),
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
and `X-Frame-Options: DENY`. CORS allow-listing in the `cors()`
middleware remains the authoritative gate for the fetch path.

This is pure defence-in-depth: CSP on a JSON response is meaningful
only if a browser ever evaluates the response as HTML (content-type
confusion, MIME sniffing on a legacy browser, etc.).
`default-src 'none'` ensures that in that scenario nothing inline
runs and no resource is fetched.

#### 5.2.3 What's intentionally NOT here yet

| Practice | Why deferred | When to revisit |
|---|---|---|
| **CSP violation reporting** (`report-to` directive + `/api/csp-report` endpoint) | Adding the directive without an endpoint generates 404 noise; building the endpoint is the right scope for the security-depth slice (Roadmap item 14). Today the browser **blocks** violating loads — only the *visibility* of attempts is deferred. | Roadmap item 14. |
| **Trusted Types** (`require-trusted-types-for 'script'`) | MDN-Baseline as of 2026 on the latest browsers; meaningful XSS-sink hardening *after* CSP is in place. Not blocking today; modest implementation effort. | Roadmap item 14 follow-on. |
| **`https://` / public-suffix `connect-src` entries** | The current `connect-src` only allows the configured `shop-api.duda1.bg` origin (or `localhost:3001` in dev). If new backend services are added the origin allow-list needs widening; treat that as part of the architecture review for any new service. | Per-service basis. |

#### 5.2.4 Verifying the policy is live

Every test below is identical on every route — that's the
property we wanted.

```bash
# Catalog homepage
curl -sI http://localhost:3000/ | grep -iE "content-security-policy|nonce|permissions-policy"

# Account login (soft-nav-safe: same strict policy as the catalog)
curl -sI http://localhost:3000/account/login | grep -iE "content-security-policy|nonce"

# API
curl -sI http://localhost:3001/health | grep -iE "content-security-policy|cross-origin|strict-transport"

# Production (replace with your domain)
curl -sI https://duda1.bg/ | grep -iE "content-security-policy|nonce"
curl -sI https://shop-api.duda1.bg/health | grep -i "content-security-policy"
```

Every shop response (whether `/`, `/products/...`, or
`/account/...`) should contain `'nonce-X' 'strict-dynamic'`. Each
request gets a different nonce — run twice and diff to confirm.
The API's CSP should be `default-src 'none'`. Drift between this
section and the live headers is a fix-now issue.

In the browser:

1. Open a fresh tab, type `http://localhost:3000/csp-test.html`,
   hit Enter. (This is a permanent diagnostic page in
   `frontend/public/csp-test.html`.) The page contains three
   intentionally-bad CSP inputs (a parser-inserted inline script,
   an `onclick=` attribute, a `javascript:` URL). All three
   should be blocked by the strict policy. The page text describes
   the expected outcome inline so anyone running the test can
   verify it without re-reading this doc.
2. Open DevTools → Network → click the document request for any
   page → Headers. The `Content-Security-Policy` header should
   contain `'nonce-...' 'strict-dynamic'` and **no**
   `'unsafe-inline'` except on `style-src` in dev.

**Why the DevTools console isn't a valid test surface.** The
classic "paste `document.createElement('script')` + `appendChild`
into the console" test gives a false negative under
`'strict-dynamic'`. The console is treated as a trusted script
source by Chrome, so anything it dynamically inserts into the DOM
inherits trust via strict-dynamic — that's exactly the case the
directive is meant to allow (so framework bundles can lazy-load
chunks). To actually exercise CSP blocking, you need parser-
inserted inline scripts in the served HTML, which is what
`/csp-test.html` provides and what real stored-XSS payloads look
like.

### 5.3 What this maps onto

OWASP Top 10 2025, full coverage matrix, lives in `COMPLIANCE.md`.
Quick summary (now reflecting the May 2026 supply-chain + CSP
slices):

- A01 Broken Access Control — ✅ (two-tier middleware)
- A02 Security Misconfiguration (newly #2) — ✅ (hybrid CSP +
  baseline security headers shipped; branch protection runbook
  documented in §9.4)
- A03 Software Supply Chain Failures (expanded) — ✅ (SCA via
  Dependabot + `npm audit`; SAST via CodeQL `security-extended`;
  SBOM CycloneDX 1.6 per workspace; SLSA L2 signed provenance)
- A04 Cryptographic Failures — ✅
- A05 Injection — ✅
- A06 Insecure Design — ✅ (idempotency, snapshots)
- A07 Authentication Failures — ✅ for admin, ✅ for customers on
  password hygiene (NIST 800-63B-4 length-only + HIBP breach
  screening shipped May 2026 + authenticated change-password
  endpoint shipped May 22 2026 closing ASVS V6.2 / NIST 800-63B-4
  §5.1.1.2). Customer MFA is the only remaining gap (Roadmap 24,
  growth-stage)
- A08 Software & Data Integrity Failures — ⚠️ no signed artifacts
- A09 Security Logging Failures — ⚠️ no distributed tracing, no CSP report
- A10 Mishandling Exceptional Conditions (new) — ✅ (RFC 9457 + graceful degradation)

### 5.4 Compliance touchpoints

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

After the May 2026 supply-chain hardening slice, this section now
describes production practice rather than aspiration.

### 9.1 What exists today

**Software Composition Analysis (third-party deps):**
- `package-lock.json` committed, reproducible installs.
- Dependabot alerts enabled (GitHub free).
- `npm audit` runs in CI on every PR.
- Single `package.json` per workspace, no spurious globally-installed
  tools at build time.

**Static Application Security Testing (first-party code):**
- **GitHub CodeQL** in `.github/workflows/codeql.yml`.
  - `security-extended` query suite on JavaScript/TypeScript.
  - `actions` query pack on workflow YAML (catches the
    tj-actions-style supply-chain compromise pattern).
  - Runs on every PR, every push to `main`, and a Sunday 03:00 UTC
    weekly cron (catches issues that newer query packs find in
    code that hasn't changed).

**Software Bill of Materials (SBOM):**
- **CycloneDX 1.6 JSON** per workspace, in `.github/workflows/sbom.yml`.
- Generated via `@cyclonedx/cyclonedx-npm@^2.0.0` with
  `--package-lock-only --omit dev` (production bundle only).
- One per deployment unit: `sbom-frontend.cdx.json`,
  `sbom-backend-db.cdx.json`, `sbom-backend-auth.cdx.json`,
  `sbom-backend-email.cdx.json`, `sbom-backend-api.cdx.json`.
- Uploaded as workflow artifacts (90-day retention) on every push;
  attached to GitHub Releases on every published tag.

**Build provenance & artifact signing (SLSA Level 2):**
- Each SBOM is signed via `actions/attest-build-provenance@v4.1.0`,
  which produces an in-toto SLSA v1.0 build-provenance attestation
  using GitHub OIDC → Sigstore Fulcio → Rekor transparency log.
- No long-lived signing keys. The signing identity IS the GitHub
  Actions workflow execution context, bound by the OIDC token
  Fulcio issued the short-lived (10-minute) X.509 cert against.

**Vulnerability disclosure (RFC 9116):**
- `frontend/public/.well-known/security.txt` published at
  `https://duda1.bg/.well-known/security.txt`.
- Bilingual policy page at `https://duda1.bg/security`
  (Bulgarian + English), aligned with ISO/IEC 29147:2018 and the EU
  CRA Annex I, Part II §5 coordinated-disclosure requirements
  effective 11 September 2026.

**CI workflow security:**
- All third-party actions pinned to 40-char commit SHAs (no version
  tags). The `# vX.Y.Z — DD MMM YYYY` comment next to each pin
  documents the verified version.
- Top-level `permissions: contents: read` on every workflow;
  individual jobs override to `write` only where strictly needed.
- `persist-credentials: false` on every checkout.
- `concurrency.cancel-in-progress: true` on every workflow.

### 9.2 What's intentionally NOT here

| Practice | Why deferred | When to revisit |
|---|---|---|
| **Signed commits** (GPG / SSH) | Single-committer repo. Branch protection on `main` + CodeQL on PRs covers the integrity surface. Signed commits add per-developer key management with marginal additional defence at this scale. | When a second human commits to `main`. |
| **SLSA Level 3** (hardened build platform) | Requires reusable workflow with build-platform isolation. Overkill for an e-commerce shop with no third-party consumers of build artifacts. | If a customer ever requires a contractual provenance SLA. |
| **Dependency Track / OWASP DC server** | The SBOMs are produced and signed; an external scanner can ingest them on demand. Self-hosting Dependency Track costs more in ops time than it saves at this dep-graph size. | When dep count > ~500 transitive or compliance specifically asks for one. |
| **CSP violation reporting** | Tracked separately in §15 item 14 (security depth slice). | Roadmap item 14. |

### 9.3 SLSA status

**Achieved: SLSA Level 2.** GitHub Actions is a hosted build
platform (L2 build platform requirement), and every artifact carries
a signed in-toto provenance attestation queryable via Rekor (L2
provenance requirement).

**Level 3** would require:
- Reusable workflow that runs the build in an isolated context
  the calling workflow can't tamper with.
- Hermetic builds (declared inputs, no network at build time).
- Build platform that produces non-falsifiable provenance — i.e.,
  attestations the build platform signs, not the calling workflow.

GitHub Actions can supply Level 3 via the `slsa-framework/slsa-github-generator`
reusable workflow. Defer until contractual need (Roadmap item 27).

### 9.4 Branch protection runbook (one-time setup)

Branch protection is the only Week 1 item that can't be checked into
the repo — it's a GitHub repository setting. Run this once per
repository; verify quarterly that nothing's drifted.

**Two rule sets** are documented below. Use the **solo-committer**
set today; switch to the **multi-committer** set the first day a
second human (or bot) gains push access.

#### Solo-committer rules (current)

**Settings → Branches → Branch protection rules → Add rule**, branch
name pattern `main`:

- ☑ **Require a pull request before merging**
  - **Require approvals: 0** ← critical. GitHub forbids approving
    your own PR, so any non-zero value deadlocks a solo-committer
    repo (every change blocked, with no way to unblock from the UI
    short of disabling protection). The PR requirement itself still
    gives you the diff view, CI signal, and a record of intent —
    that's the actual gate, not the LGTM number.
  - ☑ Dismiss stale pull request approvals when new commits are pushed
  - ☑ Require conversation resolution before merging
- ☑ **Require status checks to pass before merging**
  - ☑ Require branches to be up to date before merging
  - Required status checks (search and select each):
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
- ☐ **Require signed commits** — defer (see §9.2).
- ☑ **Require linear history** — keeps `git log` bisectable.
- ☐ **Do not allow bypassing the above settings** ← leave UNCHECKED
  in solo mode. The repository admin (you) retains an emergency
  override for the rare "production is down, revert NOW" case. This
  is a deliberate trade — slightly weaker integrity guarantee in
  exchange for a working escape hatch when no second human exists
  to unblock you.
- ☐ **Allow force pushes** — leave unchecked.
- ☐ **Allow deletions** — leave unchecked.

**Workflow this creates (works in GitHub Desktop):**

1. In GitHub Desktop: **Current Branch** dropdown → **New Branch** →
   name it (e.g. `fix/sbom-workspace-flag`).
2. Make changes, commit, **Push origin**.
3. GitHub Desktop shows a "Create Pull Request" button — click it
   (opens github.com). Or: `gh pr create --fill`.
4. Wait for the 12 status checks to go green.
5. Click **Merge pull request** on github.com (the merge button is
   enabled once checks pass).
6. Back in GitHub Desktop: **Fetch origin**, then switch back to
   `main`.

The "you can no longer push directly to `main`" surprise the first
time is the point — every change now goes through the diff +
CI gate.

#### Multi-committer rules (when you add a second human)

Switch all of the above on the day someone else commits:

- ☑ **Require approvals: 1** (now the second-pair-of-eyes gate works).
- ☑ **Require signed commits** (now key management has someone
  to coordinate with).
- ☑ **Do not allow bypassing the above settings** (no more
  emergency-override carve-out; the second admin can unblock you).
- ☑ **Require review from Code Owners** if you add a `CODEOWNERS`
  file.

#### Required-status-check deadlock — the "skipped check" gotcha

**Do not add a `paths:` or `paths-ignore:` filter to the
`pull_request:` trigger of any workflow whose status checks are
marked as required in branch protection.** If such a workflow
doesn't fire on a given PR (because no path matches the filter),
the required checks never report, and the PR will sit forever in
"Expected — Waiting for status to be reported" with no way to merge
short of admin override or temporarily un-requiring the check.

We hit this once when `sbom.yml` had a paths filter restricting it
to PRs that touched `package.json` / `package-lock.json` / the
workflow itself. A PR that only changed React components and Markdown
deadlocked all 5 `SBOM (...)` required checks. Filter removed —
SBOM now runs on every PR unconditionally. The cost is ~10
minute-runners per PR; free tier absorbs it.

If you genuinely need conditional execution to save runner minutes
(only relevant at high PR volume), the correct pattern is the
**skippable-required-check sentinel**: a downstream job that
`needs:` the matrix, runs with `if: always()`, reports success when
the matrix was skipped, and is the ONLY name marked as required.
Then the matrix jobs can have all the conditional `if:` they want.
Not implemented today — not worth the complexity at this scale.

The same constraint applies to `codeql.yml` — note its `paths-ignore`
only applies to `**.md` / `docs/**`, files that fundamentally can't
contain executable code CodeQL would analyse. Safe.

#### Verification

Try to push to `main` directly from a clean clone (any branch):

```bash
git checkout main
git commit --allow-empty -m "test: branch protection should block this"
git push
# Expect: ! [remote rejected]   main -> main (protected branch hook declined)
```

If the push succeeds, the rule didn't save — go back to Settings
and re-check the "Require a pull request before merging" box.

### 9.5 Verification (downstream consumer view)

Anyone — auditor, customer, security researcher — can independently
verify the integrity of any published SBOM without trusting the
project's CI:

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

Either command succeeds only if:
1. The SBOM byte-for-byte matches what was signed.
2. The signing identity is a workflow in this repository.
3. The signature appears in the Sigstore Rekor transparency log
   (anyone can audit Rekor for unexpected signatures from this repo).

Failure of any of those is a tampering signal.

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

### 12.4 Procedure (admin MFA seed lost)

The shop has exactly one administrator account, gated by mandatory
TOTP MFA on a separate subdomain. **Losing the TOTP seed without a
documented recovery path is the single most likely catastrophic
failure mode of this entire system** — more likely than a Neon
outage or an AWS regional incident, and harder to recover from.
This runbook makes that scenario boring.

#### 12.4.1 Where the seed is stored (set up once)

These three things must be true the day the admin account is
provisioned. Verify them quarterly along with the DR drill (§11
quarterly).

1. **Primary copy: password manager vault.** The TOTP seed
   (otpauth:// URI) is stored as a secure note in the admin's
   personal password manager (1Password / Bitwarden / iCloud
   Keychain — any vault with a strong master password and
   cloud sync). Title the entry `Best-Online-Shop admin TOTP
   seed`.
2. **Off-vault backup: paper recovery codes.** When TOTP is first
   provisioned, the authenticator app emits one-time recovery
   codes (or, equivalently, you generate them yourself by
   running TOTP against the seed at known counter offsets).
   Print the codes on paper. Seal the paper in a tamper-evident
   envelope and store it in a physical safe (home safe, bank
   safety-deposit box, or in-laws' fireproof cabinet — the
   point is "location distinct from where the password manager
   lives").
3. **Off-site copy of the cloud backup.** Confirm the password
   manager itself has 2FA enabled, AND that you have its
   recovery kit printed alongside the TOTP envelope above. If
   the password manager goes down the same day the TOTP seed
   does, you want both recovery paths.

The seed file is **never** stored in: this repository, any
unencrypted document, any chat history, any email, AWS Systems
Manager Parameter Store, or any cloud service the admin account
itself controls. Losing the AWS root means losing the shop; the
TOTP recovery path must not also be lost in that scenario.

#### 12.4.2 Recovery — Scenario A: TOTP device lost, seed preserved

This is the easy case. You forgot the device but the seed is
intact.

```
1. Open the password manager → copy the otpauth:// URI from the
   "Best-Online-Shop admin TOTP seed" entry.
2. Provision the seed into a fresh authenticator app on a new
   device. Most authenticators accept the URI directly via the
   "add account → paste setup URI" flow.
3. Open the new authenticator, generate a code, log into
   admin.duda1.bg.
4. Optional but recommended: rotate the seed. Admin panel →
   Security → "Rotate TOTP seed" → the system displays a new
   QR code and otpauth:// URI. Save the new one into the
   password manager (replacing the old). Print fresh paper
   recovery codes and replace the envelope contents.
```

Wall-clock time: 5–15 minutes. No downtime to the shop —
customer-facing routes are unaffected.

#### 12.4.3 Recovery — Scenario B: TOTP device lost AND password manager unreachable

You'd reach for the paper envelope.

```
1. Retrieve the sealed paper envelope from the safe.
2. Enter any one unused recovery code at the TOTP prompt on
   admin.duda1.bg. Recovery codes are single-use; the system
   marks the code consumed.
3. Once logged in: Admin → Security → "Rotate TOTP seed". Save
   the new seed into the password manager (recover that
   separately if needed), generate fresh recovery codes, print
   them, replace the envelope contents.
4. Cross every used recovery code off the printed list before
   re-sealing.
```

Wall-clock time: 15–30 minutes plus whatever it takes to physically
reach the envelope.

#### 12.4.4 Recovery — Scenario C: everything is lost

TOTP device gone, password manager unreachable, paper recovery
envelope destroyed (fire, flood, lost in a move). This is the
"break glass" path; the shop is admin-locked until it completes.

```
1. SSH into AWS (root credentials are stored in their own
   hardware-MFA-protected channel — see the asset inventory
   document, Roadmap item 22).
2. Connect to the production Neon branch via the SSM-stored
   read/write connection string:
     aws ssm get-parameter \
       --name /shop/prod/NEON_DATABASE_URL \
       --with-decryption \
       --region eu-central-1
3. Open psql against that URL.
4. Either:
     a. Disable MFA for the admin user:
        UPDATE users
          SET totp_secret = NULL,
              totp_verified_at = NULL
          WHERE email = '<admin-email>';
        (One transaction. Confirm exactly one row affected.)
     b. Or: rotate the seed to a known value by running the
        provisioning helper from @shop/auth offline, then
        UPDATE users SET totp_secret = '<new-encrypted-seed>'.
5. Log in to admin.duda1.bg using only the password (MFA now
   disabled).
6. Re-enrol TOTP via Admin → Security → "Enable TOTP". Save
   the new seed into a fresh password manager entry. Print
   recovery codes. Reseal.
7. Audit-log the recovery action manually — there's no
   automated event for "admin recovered MFA from psql." Write
   it in this doc (or in RUNBOOK.md once it exists), date-
   stamped, with the reason.
```

Wall-clock time: 1–2 hours including the audit-log write-up. The
shop's customer-facing functionality is unaffected throughout —
only admin operations are blocked. This is the path that requires
the AWS root credential, which is why the AWS root MFA is itself
stored in a separate secure channel from the application MFA.

#### 12.4.5 What this runbook depends on

- The admin account remains a single user with exactly one TOTP
  factor. If we add WebAuthn (Roadmap item 24 / customer MFA
  expansion), revisit this with a second-factor-quorum approach.
- The AWS root credential and the application TOTP seed are
  stored in **physically and logically distinct** locations.
  Storing both in the same password manager is a single-point-
  of-failure; storing them in the same physical safe is also
  one. The cost of this hygiene is a few minutes per
  provisioning event.
- The asset inventory document (Roadmap item 22) records
  *where* the AWS root MFA seed lives and how to retrieve it.
  This runbook assumes that document exists when Scenario C
  fires.

#### 12.4.6 Drill cadence

Run Scenario A annually as part of the yearly checklist (§11) —
specifically the "Rotate admin AWS user's hardware MFA" item.
Confirm the password manager entry opens, the paper envelope is
intact and legible, the recovery codes haven't been marked all-
consumed in some forgotten incident, and the rotation flow on
admin.duda1.bg still works. The whole drill is ~30 minutes.

Do not run Scenario C as a drill against production — practice it
against a Neon PITR branch instead so a typo in the UPDATE
statement doesn't accidentally lock you out from a working shop.

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
| Security | **A** (was A−, May 2026 supply-chain + auth-modernization slices shipped) | CSP violation reporting, customer MFA option |
| Reliability | B | Formal RTO/RPO, SQS retry queue for SES, DR drill cadence, public status page |
| Performance Efficiency | B+ | Synthetic monitoring (Lighthouse CI), RUM, query-latency SLOs per endpoint, additional image variants (800px, 2000px) |
| Cost Optimization | B− | Cloudflare swap (the big one), CloudWatch retention to 14d |
| Sustainability | A | Documented quarterly AWS CFT review |

**Cross-checked against 2026 industry standards beyond AWS WA:**

| Standard | Status | What's needed |
|---|---|---|
| NIST CSF 2.0 (Govern function) | ✅ Met (supply-chain policy + VDP shipped) | — |
| NIST CSF 2.0 (Detect function) | ⚠️ Partial | Distributed tracing |
| NIST CSF 2.0 (Respond function) | ⚠️ Partial | Incident playbook |
| OWASP Top 10 2025 — A03 Supply Chain | ✅ Met (SBOM + SLSA L2 + CodeQL) | — |
| OWASP Top 10 2025 — A08 Integrity Failures | ✅ Met (Sigstore signing) | — |
| OWASP Top 10 2025 — A02 Security Misconfiguration | ✅ Met | Uniform strict CSP shipped May 2026 (§5.2) |
| OWASP Top 10 2025 — A09 Logging Failures | ⚠️ | Distributed tracing + CSP-report endpoint (blocking already works; only reporting visibility is deferred) |
| OWASP ASVS 6.0 L1 | ✅ Compliant | — |
| OWASP ASVS 6.0 V6.2 (password lifecycle) | ✅ Met (May 22 2026) | Self-service change-password endpoint shipped with HIBP screening, same-password rejection, shared-with-/login lockout |
| OWASP ASVS 6.0 L2 | ⚠️ Gaps | Customer MFA (SAST shipped via CodeQL) |
| NIST SP 800-63B-4 | ✅ Met (May 2026) | Length-only ≥12 + HIBP screening shipped; composition rules removed |
| NIST SP 800-207 (Zero Trust) | ✅ Spirit | Already verifying every request; per-Lambda least-privilege IAM; no implicit subdomain trust |
| SLSA v1.1 | ✅ Level 2 achieved (May 2026) | Level 3 only if contractual need (Roadmap 27) |
| CIS Controls v8.1 IG1 | ✅ Met (VDP page + SBOM-as-inventory) | — |
| GDPR Art. 32 / 17 / 20 | ✅ | — |
| GDPR Art. 33–34 (72h breach) | ⚠️ | Playbook |
| EU Directive 2023/2673 | ✅ Shipped | — |
| EU CRA (Sep 2026 vuln reporting) | ✅ Ready (SBOM + RFC 9116 VDP shipped) | — |
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

### Week 1 — supply-chain hardening (SHIPPED May 2026)

1. ✅ **Branch protection on `main`** — runbook in §9.4. One-time
   GitHub UI action; verify quarterly.
2. ✅ **`.well-known/security.txt`** — `frontend/public/.well-known/security.txt`,
   policy page at `/security` (bilingual). Renew the `Expires:`
   field annually (see §11 Yearly).
3. ✅ **CodeQL SAST** — `.github/workflows/codeql.yml` on v4.35.1.
   `security-extended` query suite + the `actions` query pack for
   workflow YAML.
4. ✅ **CycloneDX SBOM per workspace** — `.github/workflows/sbom.yml`.
   CycloneDX 1.6 JSON via `@cyclonedx/cyclonedx-npm@^2.0.0`,
   one per deployment unit, attached to releases.
5. ✅ **Sigstore keyless signing** — `actions/attest-build-provenance@v4.1.0`
   in the same workflow. SLSA Level 2 achieved. Verification
   procedure in §9.5.

### Week 1 — Content Security Policy (SHIPPED May 2026)

5a. ✅ **Uniform strict CSP rollout.** A single `'nonce-X' 'strict-dynamic'`
    policy applied to every HTML document via `frontend/src/proxy.ts`
    (every route except Next.js internals, `/api`, `/.well-known`, and
    prefetch requests). The earlier hybrid attempt was found to be silently
    bypassed by SPA soft navigation; the uniform model closes that gap.
    Reasoning + rejected design recorded in §5.2. On the Hono JSON API,
    the strictest possible `default-src 'none'` via `hono/secure-headers`
    in `backend/shop-api/src/app.ts`. Plus baseline headers
    (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
    `X-Frame-Options`, `COOP`, `CORP`, `HSTS`) on every frontend response
    via `frontend/next.config.ts`. Verification recipe in §5.2.4.

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

### Account deletion — GDPR Art. 17 (SHIPPED May 24, 2026)

17c. ✅ **`DELETE /auth/me` for self-service right-to-erasure.**
     Closes the user-visible gap where the profile page had no way to
     delete the account, and the documentation honesty gap where
     `COMPLIANCE.md` previously claimed Art. 17 was shipped despite zero
     code existing. The endpoint is gated by `requireAuth` + current-
     password re-auth (defeats the stolen-cookie threat) + a typed
     confirmation phrase locked to the Bulgarian literal `"ИЗТРИЙ"` via
     `z.literal` (defence against mis-clicked DELETE from a TS-typed
     client). The deletion runs in a single transaction (see
     `backend/shop-api/src/lib/account-deletion.ts`) that balances two
     binding regimes: GDPR Art. 17(1) "without undue delay" execution
     vs the Bulgarian Accountancy Act's 10-year invoice-retention
     mandate. Art. 17(3)(b) explicitly carves out the legal-obligation
     exemption — we keep the legally-mandated records and pseudonymise
     the linking PII. Hard-deleted: `customer_profiles` /
     `corporate_profiles` / `addresses` / `carts` / `discounts` /
     `mfa_recovery_codes` / `sessions` (all of them) /
     `email_verification_tokens` / `password_reset_tokens` /
     `login_attempts` (matched by email — Art. 5(1)(c) data
     minimisation). Pseudonymised: `users` row stays in place with
     `email` rewritten to `deleted-<uuid>@deleted.invalid` (RFC 6761
     reserves `.invalid`) so the original email is freed for re-
     registration AND the `users_email_unique` index is preserved;
     `passwordHash` rewritten to a non-Argon2 sentinel so even if the
     `deletedAt` filter is bypassed somewhere downstream
     `verifyPassword` rejects the sentinel as malformed (defence in
     depth); `deletedAt` + `anonymizedAt` set. Orders kept with
     `customerId=NULL` and `customerEmail`/`customerName`/
     `customerPhone` set to `"[deleted]"`; financial columns and
     `order_items` snapshots untouched (invoice content). Delivery-
     address: `street` + `apartmentOrOffice` blanked; `city` +
     `postalCode` preserved (coarse-grained tax-territory data, no
     longer identifying). Corporate-data snapshot: only `contactName`
     blanked — `companyName` + `eik` + `vatNumber` +
     `registeredAddress` + `mol` are LEGALLY REQUIRED invoice fields
     under Bulgarian VAT law and stay intact. Complaints (where the
     customer was the deleted user): customer_email/name/phone
     blanked; `reason` enum + `description` kept (Art. 11a durable-
     medium audit trail). Active-order check returns `422
     /problems/active-orders-block-deletion` with blocking
     orderNumbers in `errors[].path` — Art. 6(1)(b) "contract
     performance" supersedes Art. 17 erasure while shipping is in
     flight. Admin self-deletion via this endpoint returns 403 (the
     shop has exactly one admin account by design — see §12.4 MFA
     recovery runbook). Adjacent endpoints already filter
     `isNull(deletedAt)` for enumeration resistance (`/auth/login`
     constant-time-with-DUMMY_PASSWORD_HASH, `/auth/forgot-password`
     silently-200, `/auth/email-change/request` conflict check) — no
     code changes needed there. Post-deletion notification email
     (`auth.account-deleted`, Bulgarian) sent best-effort to the
     ORIGINAL address (captured before the transaction rewrites
     `users.email`); explains what was deleted, what is legally
     retained, and how to react if the recipient did not initiate the
     deletion. Audit trail via structured Pino `account_deleted`
     event (`userId` + `pseudonymizedAt` timestamp + IP + UA; never
     the original email value). The pre-existing `admin_audit_log`
     table is intentionally NOT used (subject-on-self vs actor=admin
     posture — same call as PATCH /auth/me). No CSRF token (SameSite=
     Lax + same-origin DELETE + re-auth covers it). Closes **GDPR
     Art. 17** (right to erasure) and the user-visible gap in
     docs/README.md §8.

### Profile editing — GDPR Art. 16 (SHIPPED May 23, 2026)

17b. ✅ **`PATCH /auth/me` for self-service profile rectification.**
     Closes the user-visible gap where `/account/profile`'s
     personal-data section was a client-only stub. Account-type-aware
     partial update (RFC 5789 semantics, not RFC 7396 merge-patch —
     we use a typed Zod schema with per-field validation messages
     rather than the implicit null-as-delete convention). Personal
     accounts edit `fullName` + `phone`; corporate accounts edit
     `companyName` + `vatNumber` (nullable) + `registeredAddress` +
     `mol` + `contactName` + `contactPhone`. Phone normalised to
     Bulgarian E.164 by `backend/shop-api/src/lib/phone.ts` (hand-
     rolled, ~20 lines, zero deps — swap for `libphonenumber-js` if
     multi-country support ever lands). EIK / email / password /
     role / accountType deliberately NOT editable (each has its own
     flow or is structurally immutable). Zod `.strict()` rejects
     unknown fields BEFORE the handler runs (defence-in-depth
     against role/email/eik smuggling). Handler-level allowlist
     rejects cross-account fields with per-field errors. No-op
     short-circuit — submitting only unchanged values returns 200
     without writing or bumping `updated_at`. Audit trail via
     structured Pino `profile_updated` event carrying the list of
     changed field NAMES (never values — values are PII; CloudWatch
     logs are the wrong place for them). The pre-existing
     `admin_audit_log` table is intentionally NOT used (that table
     is for actor=admin, not subject-acting-on-self). GET `/auth/me`
     was extended additively with a sibling `profile` field
     (discriminated union by `kind`) so the form can hydrate from
     server truth on mount. Closes **GDPR Art. 16**
     (rectification) and the user-visible gap in docs/README.md §8.

### Week 3 — auth modernization (SHIPPED May 2026)

15. ✅ **HIBP k-anonymity check on registration / password reset** —
    `backend/auth/src/breached-password.ts`. SHA-1 the password,
    transmit only the first 5 hex chars (k-anonymity), reject on
    `count ≥ 1`. Fail-open on HIBP unavailability with a structured
    `breached_password_check_unavailable` warning log so we can alert
    on a rate spike. Threshold and fail-mode rationale documented in
    the module header. Wired into `POST /auth/register` (before the
    existing-email check, to keep response-shape enumeration-resistant),
    into `POST /auth/reset-password` (before token consumption, so
    a breached-password retry doesn't burn the reset token), AND
    into `POST /auth/change-password` (before the current-password
    verify, so a breached-new-password retry doesn't pressure the
    shared-with-/login lockout counter).
17. ✅ **Customer password rules: composition → length-only** — server
    `PasswordSchema` is now `min 12`, `max 1024`, no upper/lower/digit
    refinements. Frontend register + reset-password + profile
    change-password forms updated in lockstep. Rejection of breached
    passwords carries a dedicated `type: "/problems/breached-password"`
    problem URL so the client can render a Bulgarian message instead
    of surfacing English from the API.
17a. ✅ **Authenticated self-service password change** (shipped
    May 22 2026) — `POST /auth/change-password`. Requires session +
    current-password re-auth. HIBP-screens the new password,
    rejects newPassword === currentPassword with `/problems/same-
    password`, shares the per-email lockout counter with `/auth/login`,
    on success rotates the Argon2id hash + drops every OTHER session
    for the user (keeps THIS session — `deleteAllSessionsForUser(uid,
    keepIdHash)`) + sends a best-effort "your password was changed"
    notification. Closes OWASP ASVS V6.2 / NIST SP 800-63B-4
    §5.1.1.2. The profile page password section is now wired (was a
    client-only mock); the personal-data section is still a stub
    awaiting a separate `PATCH /auth/me` slice.

### Week 3 — security depth (remaining)

14. **Add CSP violation report endpoint** (2 hours)
    - `POST /api/csp-report` that writes the report into CloudWatch.
    - Add `report-to` directive to the CSP header.
16. **Add a `THREAT_MODEL.md`** (2 hours)
    - STRIDE pass over each major data flow. Document mitigations.

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
