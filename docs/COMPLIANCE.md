# Compliance — 2026 standards mapping

> Auditor-facing companion to `ARCHITECTURE.md`. Each section is a
> tabular mapping between a published standard and the project's
> current implementation, with explicit gap notes.
>
> Status legend:
> - ✅ Compliant — requirement met by current implementation
> - ⚠️ Partial — requirement partially met; gap identified
> - ❌ Not implemented — gap identified, remediation listed in
>   `ARCHITECTURE.md` §15
> - N/A — out of scope for this product (justified below the table)
>
> **Important framing.** As of 2026-05-26 the codebase is not yet
> deployed to production AWS. Some controls below are met by
> in-repo code that runs locally but will not be *operationally*
> verifiable until the deployment exists. Where this distinction
> matters the "Notes" column is explicit; the bare ✅/⚠️/❌ refers to
> whether the *control* is in place, not whether it is running in
> production.
>
> Last updated: 2026-05-26.

---

## Contents

1. [Standards in scope](#1-standards-in-scope)
2. [AWS Well-Architected Framework](#2-aws-well-architected-framework)
3. [NIST Cybersecurity Framework 2.0](#3-nist-cybersecurity-framework-20)
4. [OWASP Top 10 2025](#4-owasp-top-10-2025)
5. [OWASP ASVS 6.0](#5-owasp-asvs-60)
6. [NIST SP 800-63B-4 — Digital Identity](#6-nist-sp-800-63b-4--digital-identity)
7. [NIST SP 800-207 — Zero Trust](#7-nist-sp-800-207--zero-trust)
8. [SLSA v1.1 — Supply Chain](#8-slsa-v11--supply-chain)
9. [CIS Controls v8.1 — IG1](#9-cis-controls-v81--ig1)
10. [GDPR](#10-gdpr)
11. [EU Cyber Resilience Act](#11-eu-cyber-resilience-act)
12. [EU Directive 2023/2673 — right of withdrawal](#12-eu-directive-20232673--right-of-withdrawal)
13. [WCAG 2.2 / European Accessibility Act](#13-wcag-22--european-accessibility-act)
14. [Standards justified as out of scope](#14-standards-justified-as-out-of-scope)

---

## 1. Standards in scope

The product is:
- A B2C and B2B e-commerce shop in Bulgaria (EU member state).
- Selling physical goods, cash on delivery or pay at the physical
  store. **No card data is processed.**
- Intended for hosting in AWS Frankfurt (`eu-central-1`).
- Single-administrator, single-tenant.

This brings the following standards into scope:

| Standard | Why it applies |
|---|---|
| AWS Well-Architected Framework | Project's intended hosting is AWS |
| NIST CSF 2.0 | Universal cybersecurity baseline; adopted by EU/USA regulators |
| OWASP Top 10 2025 | Web application vulnerability baseline |
| OWASP ASVS 6.0 | Application security verification standard |
| NIST SP 800-63B-4 | Identity / authenticator requirements |
| NIST SP 800-207 (Zero Trust) | Architecture principles for cloud-native apps |
| SLSA v1.1 | Build provenance and supply-chain integrity |
| CIS Controls v8.1 IG1 | Small-business cybersecurity baseline |
| GDPR | EU personal data processing |
| EU Directive 2023/2673 | 14-day right of withdrawal, mandatory June 19, 2026 |
| WCAG 2.2 AA / European Accessibility Act | Mandatory for EU e-commerce since June 2025 |

Out of scope (with justification in §14): PCI-DSS, NIS2, SOC 2,
ISO 27001, HIPAA, EU AI Act, **EU CRA** (SaaS exemption — voluntary
hygiene is still in §11).

---

## 2. AWS Well-Architected Framework

Six pillars from the November 6, 2024 framework revision plus the
April 2025 best-practices update.

Many Pillar rows below are about deployed AWS infrastructure that
does not yet exist (see `README.md` "Deployment status"). Where the
control is met by code-in-repo but will not be operationally
exercised until deployment, the cell is annotated.

### Pillar 1 — Operational Excellence

| Best practice | Status | Notes |
|---|---|---|
| Infrastructure as Code (Terraform) | ❌ | `infra/` directory does not yet exist. Roadmap item 16 |
| Automated CI/CD | ✅ | GitHub Actions, 5 parallel jobs in ci.yml + CodeQL + SBOM workflows |
| Atomic blue/green deployments | N/A today | Target: AWS Amplify atomic deploys once deployed |
| Structured JSON logs | ✅ | Pino + PII redaction. Runs locally; lands in CloudWatch once deployed |
| Per-request correlation IDs | ✅ | `X-Request-Id` |
| CloudWatch alarms on key metrics | ❌ Today | Target: 5 alarms (5xx rate, admin logins, p99 duration, scheduler failure, SES bounces). Not deployed |
| Cron via managed service | ❌ Today | Target: EventBridge Scheduler invoking `scheduler-fn`. Scheduler Lambda not built |
| Runbooks documented | ⚠️ | DR procedure + MFA recovery documented in ARCHITECTURE.md §12. No incident response playbook yet |
| **Distributed tracing** | ❌ | Not yet added. Roadmap item 17 (ADOT) |
| **Formal SLO definitions** | ❌ | Targets exist informally in ARCHITECTURE.md §7.2. Roadmap item 24 |
| **DORA metrics tracked** | ❌ | Not yet instrumented |
| **DR drill cadence** | ❌ | Procedure documented; never tested. Roadmap item 18 |
| **Incident postmortem template** | ❌ | Roadmap item 31 |
| **Status page** | ❌ | Roadmap item 30 |

### Pillar 2 — Security

| Best practice | Status | Notes |
|---|---|---|
| Defence in depth | ⚠️ | Code-side ✅ (CSP, RFC 9457, two-tier auth, etc.). Target WAF + CloudFront layer not yet deployed |
| TLS 1.3 + HSTS preload | ⚠️ Code ready | HSTS header emitted in production builds via `next.config.ts`. Operational verification requires deployment behind CloudFront/ACM |
| Argon2id password hashing | ✅ | `m=19456, t=2, p=1`, RFC 9106 |
| Constant-time login | ✅ | Defeats enumeration via timing — DUMMY_PASSWORD_HASH fallback for unknown emails |
| **MFA for admin** | ❌ | Admin auth flow not built. Schema has `totp_secret` columns; no enrolment / verify routes exist. Roadmap item 35 |
| IAM least privilege per Lambda | N/A today | Target: three separate execution roles once deployed |
| Secrets in Parameter Store | N/A today | Target: SSM Parameter Store. Today: `.env` files for local dev |
| Parametrized queries (no SQLi vector) | ✅ | Drizzle ORM |
| Zod schema validation on every endpoint | ✅ | |
| WAF managed rules | N/A today | Target: AWS WAF Common + SQLi managed rules, or Cloudflare equivalent |
| `__Host-`-prefixed session cookies | ✅ Code ready | Switches on `NODE_ENV=production` |
| Brute-force defence (per-email) | ✅ | 5 fails / 15 min lockout |
| Account enumeration resistance | ✅ | Identical responses for known/unknown emails on register, login, forgot-password, email-change/request |
| RFC 9457 Problem Details | ✅ | No internal-state leakage |
| Encryption at rest | N/A today | Target: Neon-managed encryption + S3 SSE |
| Idempotency on orders | ✅ | `Idempotency-Key` UNIQUE on orders row |
| Email-verified gate on order placement | ✅ | `/problems/email-not-verified` 403 |
| **Content Security Policy — uniform strict** | ✅ | `'nonce-X' 'strict-dynamic'` on every HTML document via `frontend/src/proxy.ts`. JSON API gets `default-src 'none'` via `hono/secure-headers`. Earlier hybrid attempt and bypass documented in ARCHITECTURE.md §5.2 |
| **Baseline security headers** | ✅ | `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP, CORP, HSTS |
| Dependabot + `npm audit` (SCA) | ✅ | |
| **SAST in CI** (CodeQL `security-extended` + `actions` queries) | ✅ | `.github/workflows/codeql.yml`; weekly cron catches drift |
| **SBOM generation** (CycloneDX 1.6 per workspace) | ✅ | `.github/workflows/sbom.yml`; attached to releases |
| **SLSA L2 signed provenance** | ✅ | Sigstore keyless via `actions/attest-build-provenance@v4.1.0` |
| **`security.txt`** (RFC 9116) | ✅ | `frontend/public/.well-known/security.txt`; policy at `/security` |
| **Branch protection on `main`** | ⚠️ | Runbook ARCHITECTURE.md §9.4; not yet applied in GitHub UI |
| **CSP violation reporting** | ✅ | `POST /csp-report` accepts both legacy and modern wire formats; Pino `csp_violation` structured log at warn; browser-extension noise downgraded to debug; per-IP rate limit (60/min) |
| **HIBP breach-list check** | ✅ | `backend/auth/src/breached-password.ts`; wired into `/auth/register`, `/auth/reset-password`, `/auth/change-password`. Fail-open with warning log |
| **NIST SP 800-63B-4 password rules (length-only ≥12)** | ✅ | `PasswordSchema` in `backend/shop-api/src/routes/auth.ts`; composition rules removed |
| **Customer MFA option** | ❌ | Roadmap item 34 (growth-stage) |
| **STRIDE threat model document** | ❌ | Roadmap item 33 |

### Pillar 3 — Reliability

| Best practice | Status | Notes |
|---|---|---|
| Multi-AZ (Lambda, CloudFront, S3) | N/A today | Target: AWS-managed by default once deployed |
| Atomic deployments | N/A today | Target: Amplify |
| Idempotent operations | ✅ | `POST /orders` |
| Optimistic locking | ✅ | `version` column on orders |
| Graceful degradation | ✅ | RFC 9457 errors; best-effort emails; `currentUser` does not clear cookies on DB outage |
| Daily catalog backups | ❌ Today | Target: scheduler-fn → S3 daily, 90-day retention + Glacier. Scheduler not built |
| PITR | N/A today | Target: 7d on Neon Launch, 30d on Scale |
| Expand-contract migration discipline | ✅ | Documented + practised |
| Honest SPOF acknowledgement | ✅ | Neon Free/Launch documented as SPOF in ARCHITECTURE.md §6 |
| **Formal RTO/RPO targets** | ❌ | Targets documented in ARCHITECTURE.md §6.2; not yet operationalised |
| **SQS retry queue for SES** | ❌ | Withdrawal-receipt + order-confirmation durable-medium audit margin. Roadmap item 20 |
| **DR drill cadence** | ❌ | Roadmap item 18 |
| **Public status page** | ❌ | Roadmap item 30 |
| **Multi-region failover** | ❌ | Roadmap item 37 (deferred until contractual SLA) |
| **99.95% SLA-backed DB** | ❌ | Requires Neon Scale upgrade — defer until contractual |

### Pillar 4 — Performance Efficiency

| Best practice | Status | Notes |
|---|---|---|
| Global CDN | N/A today | Target: CloudFront once deployed |
| HTTP/3 (QUIC) | N/A today | Target: enabled by Amplify / CloudFront |
| Pre-optimised images | N/A today | Target: Sharp.js at upload, not request. Today: no upload path exists (admin Lambda not built) |
| ISR + PPR | ❌ | Next.js 16 supports both, but every route in this app is dynamic because `getServerUser()` reads cookies on SSR. Documented in ARCHITECTURE.md §5.2 |
| Connection pooling | ✅ Code ready | Each Lambda container: 3-connection pool, opened outside the handler |
| Cursor pagination | ✅ | O(1) regardless of page |
| ETag middleware | ✅ | On cacheable routes |
| Core Web Vitals targets defined | ✅ | LCP <2.5s, INP <200ms, CLS <0.1. Not measured continuously |
| **Synthetic monitoring (Lighthouse CI)** | ❌ | Roadmap item 28 |
| **Real User Monitoring (RUM)** | ❌ | Roadmap item 29 |
| **Per-endpoint p95 latency budget** | ❌ | Roadmap item 25 (burn-rate alarms) |
| **Image variants for 800px / 2000px** | N/A today | Optional once image upload exists |

### Pillar 5 — Cost Optimization

| Best practice | Status | Notes |
|---|---|---|
| Pay-per-use | ✅ Architectural | Lambda, CloudFront, SES, S3 all pay-per-use once deployed |
| AWS free tier utilised | N/A today | Target: Lambda free tier covers Tier 0–4 |
| S3 lifecycle to Glacier | N/A today | Target: backups >90 days |
| CloudWatch retention 14 days | N/A today | Will be set on deployment per Roadmap item 27 |
| AWS Budgets alarm at $30 | N/A today | Target |
| **AWS WAF + Route 53 vs Cloudflare** | ⚠️ | Pre-deployment decision. Roadmap item 26 (Path A1+A2 recommended) |
| **AWS Customer Carbon Footprint review** | ❌ | Quarterly cadence suggested |

### Pillar 6 — Sustainability

| Best practice | Status | Notes |
|---|---|---|
| Zero idle compute | ✅ Architectural | All serverless in target state |
| Edge caching | N/A today | Target: CloudFront |
| Multi-tenant infrastructure | ✅ Architectural | Lambda + Amplify + CloudFront |
| Region chosen for low-carbon mix | ✅ | eu-central-1 Frankfurt — largely renewables since 2024 |
| **Quarterly carbon footprint review** | ❌ | AWS provides the tool free; documenting cadence suggested |

---

## 3. NIST Cybersecurity Framework 2.0

Published February 26, 2024. Six core functions; the new **Govern**
function (the big addition vs CSF 1.1) is what brings most of the
gaps.

### Govern (GV)

| Category | Status | Notes |
|---|---|---|
| GV.OC — Organizational context | ✅ | Solo project; documented in README + ARCHITECTURE.md |
| GV.RM — Risk management strategy | ⚠️ | Implicit in ARCHITECTURE.md §5–6; no separate risk register |
| GV.RR — Roles, responsibilities, authorities | ⚠️ | Solo project; documented succession plan would help |
| GV.PO — Policy | ⚠️ | `/security` policy page shipped; SECURITY.md and PRIVACY.md not in repo |
| GV.OV — Oversight | ⚠️ | Quarterly Well-Architected Review recommended once deployed |
| GV.SC — Cybersecurity supply chain risk management | ✅ | Dependabot + CodeQL SAST + signed CycloneDX SBOMs + RFC 9116 disclosure policy |

### Identify (ID)

| Category | Status | Notes |
|---|---|---|
| ID.AM — Asset management | ⚠️ | No formal asset inventory document. Roadmap item 32 |
| ID.RA — Risk assessment | ⚠️ | Threat model implicit in ARCHITECTURE.md §5.1. Formal STRIDE pass is Roadmap item 33 |
| ID.IM — Improvement | ✅ | Continuous via CI/CD + per-slice retrospectives |

### Protect (PR)

| Category | Status | Notes |
|---|---|---|
| PR.AA — Identity management, authentication, access control | ✅ | Argon2id, customer auth, IAM-architectural |
| PR.AT — Awareness and training | N/A | Solo project |
| PR.DS — Data security | ⚠️ | Code-level controls ✅; encryption at rest depends on deployed Neon + S3 |
| PR.PS — Platform security | ⚠️ | Managed Lambda runtime + managed Postgres in target state; not deployed |
| PR.IR — Infrastructure resilience | ⚠️ | Multi-AZ in target state; multi-region deferred |

### Detect (DE)

| Category | Status | Notes |
|---|---|---|
| DE.CM — Continuous monitoring | ⚠️ | CSP violation reporting yes; CloudWatch alarms (target) and distributed tracing not yet |
| DE.AE — Adverse event analysis | ⚠️ | Pino logs yes (incl. `csp_violation` structured event); tracing no |

### Respond (RS)

| Category | Status | Notes |
|---|---|---|
| RS.MA — Incident management | ❌ | No playbook. Roadmap item 31 |
| RS.AN — Incident analysis | ❌ | No postmortem template |
| RS.CO — Incident response reporting and communication | ❌ | No status page; no notification SOP |
| RS.MI — Incident mitigation | ✅ | Idempotency, graceful degradation, alarm-based detection (once deployed) |

### Recover (RC)

| Category | Status | Notes |
|---|---|---|
| RC.RP — Incident recovery plan execution | ⚠️ | Procedures documented; never drilled. Roadmap item 18 |
| RC.CO — Incident recovery communication | ❌ | No public status page |

---

## 4. OWASP Top 10 2025

Published 2024–2025 (eighth edition). Notable changes vs 2021:
- **A02 Security Misconfiguration** moved from #5 to #2.
- **A03 was "Vulnerable and Outdated Components"; now "Software
  Supply Chain Failures"** — broader, includes build systems and
  distribution infrastructure.
- **A10 is new: "Mishandling of Exceptional Conditions"** —
  failure-mode handling, error paths, default behaviours.
- SSRF was absorbed into A01 Broken Access Control.

| # | Category | Status | Where it's defended |
|---|---|---|---|
| A01 | Broken Access Control (incl. SSRF) | ✅ | Two-tier middleware (`currentUser` + `requireAuth`); same-origin API; explicit auth gate on order placement; per-customer scoping returns generic 404 for someone else's order (no enumeration) |
| A02 | Security Misconfiguration | ✅ | No hardcoded secrets; `__Host-` cookies; HSTS; uniform strict CSP (`'nonce-X' 'strict-dynamic'` on every HTML document, `default-src 'none'` on the Hono API — see ARCHITECTURE.md §5.2) |
| A03 | Software Supply Chain Failures | ✅ | SCA via Dependabot + `npm audit`; CodeQL SAST `security-extended` weekly + on PR; CycloneDX SBOM per workspace; SLSA L2 signed provenance |
| A04 | Cryptographic Failures | ⚠️ | TLS 1.3 + HSTS code-ready; AES at rest depends on deployed Neon/S3. Argon2id (RFC 9106), 32-byte CSPRNG tokens, SHA-256-at-rest all in code |
| A05 | Injection | ✅ | Zod validation + Drizzle parametrized queries everywhere; WAF SQLi managed rules planned |
| A06 | Insecure Design | ✅ | Idempotency, optimistic locking, line-item snapshots, expand-contract migrations, account-discount server-controlled |
| A07 | Authentication Failures | ⚠️ | Customer-side ✅ (Argon2id RFC 9106, constant-time login, per-email lockout, NIST 800-63B-4 + HIBP). Admin MFA documented but **admin auth flow not built** (Roadmap item 35). Customer MFA is a growth-stage residual (Roadmap item 34) |
| A08 | Software and Data Integrity Failures | ✅ | Every SBOM signed via Sigstore Fulcio/Rekor, keyless OIDC, transparency log. Verification in ARCHITECTURE.md §9.5 |
| A09 | Security Logging and Monitoring Failures | ⚠️ | Pino structured logs ✅; CSP violation reporting ✅ (May 2026); distributed tracing ❌. Roadmap item 17 |
| A10 | Mishandling of Exceptional Conditions (new) | ✅ | RFC 9457 Problem Details on every error; graceful degradation; best-effort emails never block |

E-commerce-specific OWASP 2025 vulnerabilities flagged in research:

| Vulnerability | Status |
|---|---|
| Missing rate limiting on account creation / password reset | ✅ Per-email and per-account rate limits |
| Discount code brute-force | N/A (per-account discounts, no public codes) |
| Client-side price calculation | ✅ All price math server-side; cart hydrates from live `products` table |
| Price manipulation via request body | ✅ Server recalculates total at checkout from current catalog prices |
| Discount escalation | ✅ Account discount looked up server-side, not from request |

---

## 5. OWASP ASVS 6.0

Released 2024. Levels: L1 (baseline), L2 (sensitive-data apps),
L3 (high-assurance / critical systems).

| Chapter | L1 status | L2 status | Notes |
|---|---|---|---|
| V1 Architecture, Design and Threat Modeling | ⚠️ | ⚠️ | Architecture documented; formal STRIDE threat model missing |
| V2 Authentication | ✅ | ⚠️ | L1 met for customers; L2 needs customer MFA (Roadmap 33). V6.2 self-service password change shipped May 22, 2026 |
| V3 Session Management | ✅ | ✅ | 256-bit tokens, hashed at rest, all-session-drop on reset/email-change/account-deletion |
| V4 Access Control | ✅ | ✅ | Two-tier middleware; explicit gates |
| V5 Validation, Sanitization, Encoding | ✅ | ✅ | Zod `.strict()` on every endpoint |
| V6 Stored Cryptography | ✅ | ✅ | Argon2id (RFC 9106). AES at rest depends on deployed environment |
| V7 Error Handling and Logging | ✅ | ✅ | RFC 9457 + Pino + PII redaction |
| V8 Data Protection | ✅ | ✅ | GDPR-aligned (Art. 32) |
| V9 Communications Security | ✅ | ✅ | TLS 1.3, HSTS preload (production builds), uniform strict CSP |
| V10 Malicious Code | ✅ | ✅ | SAST via CodeQL `security-extended`; SCA via Dependabot |
| V11 Business Logic | ✅ | ✅ | Idempotency, expand-contract, snapshots |
| V12 Files and Resources | N/A | N/A | No file upload path exists today (no admin Lambda); covered when image upload ships |
| V13 API and Web Service | ✅ | ✅ | Hono + zod-openapi + RFC 9457 |
| V14 Configuration | ⚠️ | ⚠️ | `.env` for local dev; Parameter Store planned for production |

**Net:** **L1-compliant** for customer-facing flows in code. **L2
gaps:** customer MFA (Roadmap 33); admin auth flow (Roadmap 34).

---

## 6. NIST SP 800-63B-4 — Digital Identity

2024 revision of NIST's identity guidelines. Key changes from
800-63B-3: deprecates composition rules in favour of length +
breach-list checks.

| Requirement | Status | Notes |
|---|---|---|
| Memorised secret minimum 8 characters | ✅ | Project enforces ≥12 — above NIST floor |
| Memorised secret max 64+ characters | ✅ | 1024-char ceiling (cost protection only) |
| Argon2id or equivalent for storage | ✅ | RFC 9106 compliant |
| Composition rules (upper/lower/digit) DEPRECATED | ✅ Removed (May 2026) | Stripped from `PasswordSchema` |
| Breach-list check (HIBP k-anonymity) | ✅ Shipped (May 2026) | `backend/auth/src/breached-password.ts`. Wired into `/auth/register`, `/auth/reset-password`, `/auth/change-password`. Fail-open with structured `breached_password_check_unavailable` warning log |
| §5.1.1.2 Subscribers SHALL be able to change their memorised secret | ✅ Shipped (May 22, 2026) | `POST /auth/change-password` |
| Single-use, time-bound recovery tokens | ✅ | 1-hour validity for reset / email-change, 24h for signup. SHA-256-hashed at rest |
| Drop sessions on password change | ✅ | `/auth/reset-password` drops ALL sessions (unauthenticated flow). `/auth/change-password` drops every OTHER session, keeps the initiating one |
| Out-of-band notification at email change | ✅ | Old + new addresses notified |
| AAL1 for customer accounts | ✅ | Password + cookie session |
| AAL2 for admin via TOTP MFA | ❌ | Admin auth flow not built. Schema has `totp_secret` columns. Roadmap item 35 |

---

## 7. NIST SP 800-207 — Zero Trust Architecture

Finalized August 2020; SP 800-207A (multi-cloud) followed. Seven
tenets:

| Tenet | Status | Notes |
|---|---|---|
| All data sources and computing services are considered resources | ✅ | API + DB treated as resources |
| All communication is secured regardless of network location | ✅ Code-side | TLS 1.3 in target deployment; locally HTTP loopback |
| Access to individual enterprise resources is granted on a per-session basis | ✅ | Cookies are short-lived; sessions revocable |
| Access to resources is determined by dynamic policy | ⚠️ | Static IAM policies in target deployment; no risk-adaptive auth |
| The enterprise monitors and measures the integrity and security posture of all owned and associated assets | ⚠️ | Dependabot + CodeQL; CloudWatch alarms once deployed; no distributed tracing |
| All resource authentication and authorization are dynamic and strictly enforced before access is allowed | ✅ | Per-request `currentUser` / `requireAuth` |
| The enterprise collects information about asset state, network/communications, and uses it to improve security posture | ⚠️ | Pino logs collected; not yet analysed at security-event level |

**Net:** Zero Trust *spirit* respected; full ZTA tooling (policy
decision point, policy enforcement point, identity-aware proxy) is
overkill at solo-project scale.

---

## 8. SLSA v1.1 — Supply-chain Levels for Software Artifacts

| Level | Requirements | Status |
|---|---|---|
| Level 0 | No requirements | ✅ |
| Level 1 | Provenance exists describing how the package was built | ✅ |
| Level 2 | Provenance digitally signed by hosted build platform | ✅ Achieved May 2026 |
| Level 3 | Build platform isolates runs; secrets are not accessible to user-defined steps | ❌ Not pursued |

**SLSA Level 2 — how achieved:**
- `@cyclonedx/cyclonedx-npm@^2.0.0` produces a CycloneDX 1.6 JSON
  SBOM per workspace per build (`.github/workflows/sbom.yml`).
- `actions/attest-build-provenance@v4.1.0` signs each SBOM using
  GitHub Actions' OIDC token → Sigstore Fulcio short-lived cert →
  Rekor transparency log. No long-lived keys.
- SBOMs are attached to GitHub Releases as assets; their
  attestations are queryable via `gh attestation list`.
- Verification procedure for downstream consumers in
  ARCHITECTURE.md §9.5.

**Level 3 is intentionally not pursued.** It would require a
reusable workflow with build-platform isolation. The marginal
security gain over L2 doesn't justify the operational complexity
for a single-tenant e-commerce shop. Revisit when a customer
contract requires it.

---

## 9. CIS Controls v8.1 — Implementation Group 1 (IG1)

IG1 = 56 cybersecurity safeguards. Designed as the floor for small
businesses with limited IT resources. Status across the 18 control
families:

| Control | Status |
|---|---|
| CIS 1 Inventory of Enterprise Assets | ⚠️ No formal inventory doc. Roadmap item 32 |
| CIS 2 Inventory of Software Assets | ✅ Signed CycloneDX SBOM per workspace, attached to releases |
| CIS 3 Data Protection | ⚠️ Code controls ✅; at-rest encryption depends on deployment |
| CIS 4 Secure Configuration of Enterprise Assets and Software | ⚠️ Code controls ✅; production hardening pending deployment |
| CIS 5 Account Management | ✅ |
| CIS 6 Access Control Management | ✅ |
| CIS 7 Continuous Vulnerability Management | ✅ Dependabot + CodeQL `security-extended` weekly + on every PR |
| CIS 8 Audit Log Management | ⚠️ Pino logs yes; SIEM no — acceptable at this scale |
| CIS 9 Email and Web Browser Protections | N/A (no email clients in scope) |
| CIS 10 Malware Defenses | N/A (no end-user devices in scope) |
| CIS 11 Data Recovery | ⚠️ Procedures yes; drill cadence no |
| CIS 12 Network Infrastructure Management | N/A today (no production network yet) |
| CIS 13 Network Monitoring and Defense | N/A today (no production network yet) |
| CIS 14 Security Awareness and Skills Training | N/A (solo project) |
| CIS 15 Service Provider Management | ✅ AWS shared-responsibility model + Neon contract terms |
| CIS 16 Application Software Security | ✅ CodeQL SAST + signed SBOM + RFC 9116 VDP |
| CIS 17 Incident Response Management | ❌ No playbook. Roadmap item 31 |
| CIS 18 Penetration Testing | N/A at this scale |

---

## 10. GDPR

Bulgarian shop selling to EU residents — full GDPR scope.

| Article | Requirement | Status |
|---|---|---|
| Art. 5 | Lawfulness, fairness, transparency | ✅ Privacy policy page at `/privacy`; cookie-consent schema (`cookie_consents` table) ready |
| Art. 5(1)(c) | Data minimisation | ✅ Only collects required fields per account type |
| Art. 5(1)(e) | Storage limitation | ⚠️ No retention sweep for old `login_attempts` (scheduler-fn not built — Roadmap item 23) |
| Art. 6 | Lawful basis | ✅ Contract + legitimate interest + consent |
| Art. 7 | Conditions for consent | ⚠️ Cookie consent UI exists client-side (`frontend/src/components/layout/CookieBanner.tsx`, choice persisted to `localStorage`); server-side `cookie_consents` table is in schema but not yet wired |
| Art. 12 | Transparent information | ✅ Privacy policy + clear UI copy |
| Art. 15 | Right of access | ❌ Self-service data export endpoint not built. Roadmap item 36 |
| Art. 16 | Right to rectification | ✅ Self-service `/account/profile` wired to `PATCH /auth/me` (May 23, 2026). Account-type-aware. Phone normalised to Bulgarian E.164 server-side. Audit trail via structured Pino `profile_updated` event (field NAMES only — never values). EIK / email / password / role / accountType are deliberately read-only or have dedicated flows |
| Art. 17 | Right to erasure | ✅ `DELETE /auth/me` (May 24, 2026). Current-password re-auth + typed confirmation `z.literal("ИЗТРИЙ")`. Active-order check returns `422 /problems/active-orders-block-deletion`. Single-transaction execution in `backend/shop-api/src/lib/account-deletion.ts` balances Art. 17(1) immediate erasure with the Bulgarian Accountancy Act's 10-year invoice retention via Art. 17(3)(b). Hard-deletes profiles, addresses, cart, discounts, MFA codes, sessions, tokens, login_attempts matched by email. Pseudonymises `users` (email → `deleted-<uuid>@deleted.invalid`, password_hash → non-Argon2 sentinel). Orders kept with customer fields blanked, financial columns + line-item snapshots intact. Email freed for re-registration |
| Art. 17(3)(b) | Legal-obligation retention exemption | ✅ Bulgarian Accountancy Act 10-year invoice retention; EU 2011/83/EU + 2023/2673 complaint retention. Disclosed concurrently in the post-deletion notification email |
| Art. 18 | Right to restriction | ❌ No explicit "freeze processing" flow |
| Art. 20 | Right to data portability | ❌ Self-service export not built. Roadmap item 36 |
| Art. 21 | Right to object | ⚠️ Marketing-consent rejection not yet wired; broader object-to-processing flow not built |
| Art. 25 | Privacy by design | ✅ PII redaction in logs; pseudonymised session tokens |
| Art. 32 | Security of processing | ⚠️ Code-level controls ✅; encryption at rest depends on deployment |
| Art. 33 | Breach notification to supervisory authority within 72h | ❌ No playbook documented. Roadmap item 31 |
| Art. 34 | Communication of breach to data subject | ❌ No playbook documented |
| Art. 35 | Data Protection Impact Assessment | N/A (low-risk processing) |
| Art. 44 | Data residency | ✅ Architectural — all production processing intended for `eu-central-1` |

---

## 11. EU Cyber Resilience Act

Effective dates:
- **September 11, 2026** — manufacturers must report actively
  exploited vulnerabilities within 24 hours to ENISA + national
  CSIRTs.
- **December 11, 2027** — full compliance deadline (SBOM,
  vulnerability handling, security updates for 5 years).

**The CRA does not apply to this product.** The CRA covers
"products with digital elements." Pure SaaS distributed via a web
browser is **out of scope** per the European Commission's own
guidance — software offered via SaaS is not covered unless it
qualifies as a "remote data processing solution" essential to a
physical product. This shop sells physical goods but does not ship
software, firmware, or downloadable products of any kind.

**The shop voluntarily maintains CRA-style hygiene** as general
supply-chain defence and as an investment in NIST CSF 2.0 /
OWASP Top 10 2025 alignment. The reputational and customer-trust
benefits are real even when the legal mandate doesn't apply.

| CRA-style practice | Status | Voluntarily driven by |
|---|---|---|
| SBOM published | ✅ CycloneDX 1.6 per workspace, signed, attached to releases | NIST CSF, OWASP 2025 |
| Vulnerability disclosure policy (`security.txt`) | ✅ `frontend/public/.well-known/security.txt` + bilingual `/security` policy page | RFC 9116 |
| Vulnerability handling process | ✅ Dependabot + CodeQL + 72h-ack / 90d-fix commitment in VDP | OWASP, NIST |
| Documented 24h breach reporting | ⚠️ Playbook pending (Roadmap item 31) | GDPR Art. 33 |
| Security updates available for 5+ years | ⚠️ Managed AWS services covered by their respective vendor lifecycles | — |

---

## 12. EU Directive 2023/2673 — 14-day right of withdrawal

Mandatory in all EU member states from **June 19, 2026**. This shop
ships in compliance ahead of the deadline.

| Requirement | Status |
|---|---|
| "Withdrawal button" clearly labelled | ✅ "Откажете се от договора тук" |
| Easy to find | ✅ Linked from order detail, footer, /terms, /delivery, withdrawal page header |
| Confirmation receipt on durable medium (Art. 11a(2)) | ✅ On-screen receipt is the primary durable medium per recital 37; email is defence in depth |
| Receipt includes date/time of withdrawal | ✅ Sofia timezone, second precision |
| No dark patterns (recital 37) | ✅ No double-confirm, no countdown, no upsell |
| Optional reason | ✅ Marked "по избор" |
| **Confirmation of contract on durable medium (Art. 8(7), 2011/83/EU as amended by 2023/2673)** | ✅ `orders.order-confirmation` email fires from `POST /orders` after the checkout transaction commits. Includes the trader identity, line snapshots with frozen prices, money totals, payment + delivery arrangement, and a 14-day withdrawal-rights pointer (Art. 6(1)(h)). Idempotency-replay does NOT re-send. Backed by 5 integration tests in `backend/shop-api/tests/routes/order-emails.test.ts` |
| Confirmation includes pre-contract information (Art. 6) | ✅ Order snapshot carries main characteristics of the goods + total price (incl. any applied discount) + payment / delivery arrangement; withdrawal-rights are surfaced both in the email and on the per-order page at `/account/orders/{n}` |
| Confirmation is durable for the consumer (Art. 2(10)) | ✅ Email saved in the customer's mailbox (the canonical durable medium per the directive's recitals); plus a first-party `/account/orders/{n}` read path that does not depend on a third party |
| Email send-failure does not break the audit trail | ⚠️ Order-placement does not block on the email (best-effort); a transport failure logs `order_confirmation_email_failed` and the `/account/orders/{n}` page is the independent durable-medium read path. SQS retry queue (Roadmap item 20) closes the formal audit margin |
| Penalty for missing button | (Window extends to 12 months + 14 days) |

Implemented in the May 2026 withdrawal slice. Three routes:
`GET /orders/:n/withdrawal/eligibility`, `GET /orders/:n/withdrawal`,
`POST /orders/:n/withdrawal`. Idempotent at the DB level via a
partial unique index on `complaints.order_id WHERE
reason='withdrawal'`.

The order-confirmation email rows were added 2026-05-27 after the
`orders.order-confirmation` template + `sendOrderConfirmationEmail`
helper + `POST /orders` wire-up shipped. Until that revision, order
placement sent zero emails and the Art. 8(7) row was the directive's
single biggest gap; it is now closed pending the SQS retry queue.

---

## 13. WCAG 2.2 / European Accessibility Act

European Accessibility Act mandatory since **June 28, 2025** for
e-commerce serving EU residents.

| WCAG 2.2 Principle | Status |
|---|---|
| Perceivable (alt text, contrast 4.5:1, info not by colour alone) | ⚠️ Design intent in scope per docs/README §13; not continuously audited |
| Operable (keyboard nav, focus indicators, 24×24 touch targets, skip nav) | ⚠️ |
| Understandable (labels, error messages, autocomplete, predictable navigation) | ⚠️ |
| Robust (semantic HTML, ARIA, screen-reader compatibility) | ⚠️ |

WCAG 2.2 AA is the European Accessibility Act baseline. The
functional spec commits to it; **the gap is continuous audit** —
adding axe-core or Pa11y to CI (Roadmap item 28 area) would
operationalise the commitment.

---

## 14. Standards justified as out of scope

| Standard | Why out of scope |
|---|---|
| **PCI-DSS** | No PAN (cardholder data) is received, stored, or transmitted. Payment is cash on delivery / pay at store only. |
| **NIS2 Directive** | Applies to "important entities" defined by revenue/employee thresholds. The shop's scale is below those thresholds. Reassess if annual revenue exceeds ~€10M or employee count exceeds ~50. |
| **SOC 2 Type 2** | Audit framework for B2B SaaS with enterprise customers requiring attestation. Not relevant for B2C e-commerce. Would become relevant if the project pivoted to multi-tenant SaaS. |
| **ISO 27001** | Information security management certification. Useful for organisations with employees and physical premises; overhead exceeds value for a solo project. |
| **HIPAA** | US healthcare. No medical data. |
| **EU AI Act** | No AI / ML systems in the architecture. |
| **PSD2** | Payment services regulation. Payment is cash-on-delivery / pay-at-store — out of scope. |
| **EU CRA** | Pure SaaS exemption per European Commission guidance — see §11. Hygiene voluntarily maintained. |

If any of these become in-scope (project pivots, scale crosses NIS2
thresholds, B2B customer requires SOC 2 attestation), update this
matrix and add the relevant gaps to `ARCHITECTURE.md` §15.

---

*Auditor-facing reference. The narrative explanation of each gap
and its remediation lives in `ARCHITECTURE.md` (§14 "Honest
assessment" and §15 "Roadmap to A+").*
