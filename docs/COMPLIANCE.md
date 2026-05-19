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
> Last updated: 2026-05-19.

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
- Hosted in AWS Frankfurt (`eu-central-1`).
- Single-administrator, single-tenant.

This brings the following standards into scope:

| Standard | Why it applies |
|---|---|
| AWS Well-Architected Framework | The project is hosted on AWS |
| NIST CSF 2.0 | Universal cybersecurity baseline; adopted by EU/USA regulators |
| OWASP Top 10 2025 | Web application vulnerability baseline |
| OWASP ASVS 6.0 | Application security verification standard |
| NIST SP 800-63B-4 | Identity / authenticator requirements |
| NIST SP 800-207 (Zero Trust) | Architecture principles for cloud-native apps |
| SLSA v1.1 | Build provenance and supply-chain integrity |
| CIS Controls v8.1 IG1 | Small-business cybersecurity baseline |
| GDPR | EU personal data processing |
| EU CRA (debatable scope) | Vulnerability reporting baseline |
| EU Directive 2023/2673 | 14-day right of withdrawal, mandatory June 19, 2026 |
| WCAG 2.2 AA / European Accessibility Act | Mandatory for EU e-commerce since June 2025 |

Out of scope (with justification in §14): PCI-DSS, NIS2, SOC 2,
ISO 27001, HIPAA, EU AI Act.

---

## 2. AWS Well-Architected Framework

Six pillars from the November 6, 2024 framework revision plus the
April 2025 best-practices update.

### Pillar 1 — Operational Excellence

| Best practice | Status | Notes |
|---|---|---|
| Infrastructure as Code (Terraform) | ✅ | Documented in `infra/` (planned); decision recorded in `ARCHITECTURE.md` §13 |
| Automated CI/CD | ✅ | GitHub Actions, 5 parallel jobs |
| Atomic blue/green deployments | ✅ | AWS Amplify atomic deploys |
| Structured JSON logs | ✅ | Pino + PII redaction |
| Per-request correlation IDs | ✅ | `X-Request-Id` |
| CloudWatch alarms on key metrics | ✅ | 5 alarms in always-free tier |
| Cron via managed service | ✅ | EventBridge Scheduler |
| Runbooks documented | ⚠️ | DB restore + Lambda rollback + SES production request, but no incident response playbook |
| **Distributed tracing** | ❌ | X-Ray listed as "optional" — fix: add ADOT (§15 item 6) |
| **Formal SLO definitions** | ❌ | Targets exist informally; fix: §15 item 8 |
| **DORA metrics tracked** | ❌ | Fix: instrument deployment frequency, lead time, MTTR, CFR |
| **DR drill cadence** | ❌ | Procedure documented; never tested. Fix: §15 item 10 |
| **Incident postmortem template** | ❌ | Fix: §15 item 21 |
| **Status page** | ❌ | Fix: §15 item 20 |

### Pillar 2 — Security

| Best practice | Status | Notes |
|---|---|---|
| Defence in depth | ✅ | WAF → CloudFront → Lambda → Neon |
| TLS 1.3 + HSTS preload | ✅ | CloudFront managed |
| Argon2id password hashing | ✅ | `m=19456, t=2, p=1`, RFC 9106 |
| Constant-time login | ✅ | Defeats enumeration via timing |
| MFA for admin | ✅ | TOTP mandatory |
| IAM least privilege per Lambda | ✅ | Three separate execution roles |
| Secrets in Parameter Store | ✅ | No hardcoded secrets |
| Parametrized queries (no SQLi vector) | ✅ | Drizzle ORM |
| Zod schema validation on every endpoint | ✅ | |
| WAF managed rules (Common + SQLi) | ✅ | Until Cloudflare swap |
| `__Host-`-prefixed session cookies | ✅ | Production only |
| Brute-force defence (per-email) | ✅ | 5 fails / 15 min |
| Account enumeration resistance | ✅ | Identical responses for known/unknown emails |
| RFC 9457 Problem Details | ✅ | No internal-state leakage |
| Encryption at rest | ✅ | Neon + S3 SSE |
| Idempotency on orders | ✅ | `Idempotency-Key` UNIQUE |
| Email-verified gate on order placement | ✅ | |
| **Content Security Policy — uniform strict** | ✅ | Single `'nonce-X' 'strict-dynamic'` policy on every HTML document via `frontend/src/proxy.ts`; strictest possible (`default-src 'none'`) on the Hono JSON API via `hono/secure-headers`. (Previous hybrid attempt was bypassed by SPA soft navigation — rejected design recorded in `ARCHITECTURE.md` §5.2.) |
| **Baseline security headers** (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `COOP`, `CORP`, `HSTS`) | ✅ | `frontend/next.config.ts` + `backend/shop-api/src/app.ts` |
| Dependabot + `npm audit` (SCA) | ✅ | |
| **SAST in CI** (CodeQL `security-extended` + `actions` queries) | ✅ | `.github/workflows/codeql.yml`; weekly cron catches drift |
| **SBOM generation** (CycloneDX 1.6 per workspace) | ✅ | `.github/workflows/sbom.yml`; attached to releases |
| **SLSA L2 signed provenance** | ✅ | Sigstore keyless via `actions/attest-build-provenance@v4.1.0` |
| **`security.txt`** (RFC 9116) | ✅ | `frontend/public/.well-known/security.txt`; policy at `/security` |
| **Branch protection on `main`** | ✅ | Runbook: ARCHITECTURE.md §9.4 (one-time UI setup, verified quarterly) |
| **CSP violation reporting** | ❌ | Fix: ARCHITECTURE.md §15 item 14 |
| **HIBP breach-list check** | ❌ | Fix: ARCHITECTURE.md §15 item 15 |
| **Customer MFA option** | ❌ | Fix: ARCHITECTURE.md §15 item 24 (growth-stage) |
| **STRIDE threat model document** | ❌ | Fix: ARCHITECTURE.md §15 item 16 |

### Pillar 3 — Reliability

| Best practice | Status | Notes |
|---|---|---|
| Multi-AZ (Lambda, CloudFront, S3) | ✅ | AWS-managed by default |
| Atomic deployments | ✅ | Amplify |
| Idempotent operations | ✅ | `POST /orders` |
| Optimistic locking | ✅ | `version` column on orders |
| Graceful degradation | ✅ | 503 + alarm on DB outage |
| Daily catalog backups | ✅ | 90-day retention + Glacier |
| PITR | ⚠️ | 7d on Launch, 30d on Scale — but project still on Free |
| Expand-contract migration discipline | ✅ | Documented + practised |
| Honest SPOF acknowledgement | ✅ | Neon Free/Launch documented as SPOF |
| **Formal RTO/RPO targets** | ❌ | Fix: §15 item 8 |
| **SQS retry queue for SES** | ❌ | Withdrawal-receipt durable-medium gap. Fix: §15 item 7 |
| **DR drill cadence** | ❌ | Fix: §15 item 10 |
| **Public status page** | ❌ | Fix: §15 item 20 |
| **Multi-region failover** | ❌ | Deferred to Milestone 4 — acceptable |
| **99.95% SLA-backed DB** | ❌ | Requires Neon Scale upgrade — defer until contractual |

### Pillar 4 — Performance Efficiency

| Best practice | Status | Notes |
|---|---|---|
| Global CDN | ✅ | CloudFront 600+ PoPs |
| HTTP/3 (QUIC) | ✅ | Enabled |
| Pre-optimised images | ✅ | Sharp.js at upload, not request |
| ISR + PPR | ✅ | Next.js 16 |
| Connection pooling | ✅ | Neon PgBouncer |
| Cursor pagination | ✅ | O(1) regardless of page |
| ETag middleware | ✅ | On cacheable routes |
| Core Web Vitals targets defined | ✅ | LCP <2.5s, INP <200ms, CLS <0.1 |
| **Synthetic monitoring (Lighthouse CI)** | ❌ | Fix: §15 item 18 |
| **Real User Monitoring (RUM)** | ❌ | Fix: §15 item 19 |
| **Per-endpoint p95 latency budget** | ❌ | Fix: §15 item 9 (burn-rate alarms) |
| **Image variants for 800px / 2000px** | ❌ | Optional |

### Pillar 5 — Cost Optimization

| Best practice | Status | Notes |
|---|---|---|
| Pay-per-use | ✅ | Lambda, CloudFront, SES, S3 |
| AWS free tier utilised | ✅ | Lambda free tier covers Tier 0–4 |
| S3 lifecycle to Glacier | ✅ | Backups >90 days |
| CloudWatch retention 30 days | ⚠️ | Generous; 14 days suffices. Fix: §15 item 12 |
| AWS Budgets alarm at $30 | ✅ | |
| **AWS WAF + Route 53 vs Cloudflare** | ⚠️ | Unforced overpayment. Fix: §15 item 11 (Path A1+A2) |
| **Lambda → Fargate upgrade path** | ⚠️ | Historical roadmap entry; would be the wrong destination at the relevant traffic. Removed from roadmap. |
| **AWS Customer Carbon Footprint review** | ❌ | Quarterly cadence suggested |

### Pillar 6 — Sustainability

| Best practice | Status | Notes |
|---|---|---|
| Zero idle compute | ✅ | All serverless |
| Edge caching | ✅ | Reduces origin traffic |
| Multi-tenant infrastructure | ✅ | Lambda + Amplify + CloudFront |
| Region chosen for low-carbon mix | ✅ | eu-central-1 Frankfurt — largely renewables since 2024 |
| **Quarterly carbon footprint review** | ❌ | AWS provides the tool free; suggest documenting cadence |

---

## 3. NIST Cybersecurity Framework 2.0

Published February 26, 2024. Six core functions; the new **Govern**
function (the big addition vs CSF 1.1) is what brings most of the
gaps.

### Govern (GV)

| Category | Status | Notes |
|---|---|---|
| GV.OC — Organizational context | ✅ | Solo project; documented in README + ARCHITECTURE.md |
| GV.RM — Risk management strategy | ⚠️ | Implicit in `ARCHITECTURE.md` §5–6; no separate risk register |
| GV.RR — Roles, responsibilities, authorities | ⚠️ | Solo project; documented succession plan would help |
| GV.PO — Policy | ❌ | No `SECURITY.md` / `PRIVACY.md` / disclosure policy |
| GV.OV — Oversight | ⚠️ | Quarterly Well-Architected Review recommended |
| GV.SC — Cybersecurity supply chain risk management | ✅ | Dependabot + CodeQL SAST + signed CycloneDX SBOMs (per workspace) + RFC 9116 disclosure policy. See ARCHITECTURE.md §9.1 |

### Identify (ID)

| Category | Status | Notes |
|---|---|---|
| ID.AM — Asset management | ⚠️ | No formal asset inventory document. Fix: §15 item 22 |
| ID.RA — Risk assessment | ⚠️ | Threat model exists implicitly in `ARCHITECTURE.md` §5. Fix: `ARCHITECTURE.md` §15 item 16 (formal STRIDE doc) |
| ID.IM — Improvement | ✅ | Continuous via CI/CD + per-slice retrospectives |

### Protect (PR)

| Category | Status | Notes |
|---|---|---|
| PR.AA — Identity management, authentication, access control | ✅ | Strong: Argon2id, MFA admin, IAM least-privilege |
| PR.AT — Awareness and training | N/A | Solo project |
| PR.DS — Data security | ✅ | Encryption at rest + in transit; pseudonymisation of session tokens |
| PR.PS — Platform security | ✅ | Managed Lambda runtime, managed Postgres |
| PR.IR — Infrastructure resilience | ⚠️ | Multi-AZ yes; multi-region no |

### Detect (DE)

| Category | Status | Notes |
|---|---|---|
| DE.CM — Continuous monitoring | ⚠️ | CloudWatch alarms yes; distributed tracing no |
| DE.AE — Adverse event analysis | ⚠️ | Pino logs yes; tracing no |

### Respond (RS)

| Category | Status | Notes |
|---|---|---|
| RS.MA — Incident management | ⚠️ | No playbook. Fix: §15 item 21 |
| RS.AN — Incident analysis | ⚠️ | No postmortem template |
| RS.CO — Incident response reporting and communication | ⚠️ | No status page; no notification SOP |
| RS.MI — Incident mitigation | ✅ | Idempotency, graceful degradation, alarm-based detection |

### Recover (RC)

| Category | Status | Notes |
|---|---|---|
| RC.RP — Incident recovery plan execution | ⚠️ | Procedures documented; never drilled. Fix: §15 item 10 |
| RC.CO — Incident recovery communication | ⚠️ | No public status page |

---

## 4. OWASP Top 10 2025

Published 2024–2025 (eighth edition). Notable changes vs 2021:
- **A02 Security Misconfiguration** moved from #5 to #2.
- **A03 was "Vulnerable and Outdated Components"; now "Software
  Supply Chain Failures"** — broader, includes build systems and
  distribution infrastructure.
- **A10 is new: "Mishandling of Exceptional Conditions"** — failure-
  mode handling, error paths, default behaviours.
- SSRF was absorbed into A01 Broken Access Control.

| # | Category | Status | Where it's defended |
|---|---|---|---|
| A01 | Broken Access Control (incl. SSRF) | ✅ | Two-tier middleware (`currentUser` + `requireAuth`); per-Lambda IAM least-privilege; same-origin API; explicit auth gate on order placement |
| A02 | Security Misconfiguration | ✅ | No hardcoded secrets; SSM Parameter Store; `__Host-` cookies; HSTS; uniform strict CSP (`'nonce-X' 'strict-dynamic'` on every HTML document, `default-src 'none'` on the Hono API — see ARCHITECTURE.md §5.2); branch protection ruleset on `main` (§9.4) |
| A03 | Software Supply Chain Failures | ✅ Met | SCA via Dependabot + `npm audit` ✅. CodeQL SAST ✅. CycloneDX SBOM per workspace ✅. SLSA L2 signed provenance ✅. See §8 and ARCHITECTURE.md §9 |
| A04 | Cryptographic Failures | ✅ | TLS 1.3, Argon2id (RFC 9106), 32-byte CSPRNG tokens, SHA-256-at-rest, AES at rest (S3 + Neon) |
| A05 | Injection | ✅ | Zod validation + Drizzle parametrized queries everywhere; WAF SQLi managed rules as backstop |
| A06 | Insecure Design | ✅ | Idempotency, optimistic locking, line-item snapshots, expand-contract migrations, account-discount server-controlled |
| A07 | Authentication Failures | ⚠️ | Strong for admin (MFA); customer MFA missing (ASVS L2 gap). Fix: §15 item 24 |
| A08 | Software and Data Integrity Failures | ✅ Met | Every SBOM signed via Sigstore Fulcio/Rekor (`actions/attest-build-provenance@v4.1.0`), keyless OIDC, transparency log. Verification procedure in ARCHITECTURE.md §9.5 |
| A09 | Security Logging and Monitoring Failures | ⚠️ | Pino structured logs ✅; distributed tracing ❌; CSP violation reporting ❌. Fix: §15 items 6 + 14 |
| A10 | Mishandling of Exceptional Conditions (new) | ✅ | RFC 9457 Problem Details on every error; graceful degradation (DB outage → 503 + alarm, not silent failure); best-effort email never blocks |

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
| V1 Architecture, Design and Threat Modeling | ⚠️ | ⚠️ | Architecture documented; STRIDE threat model missing |
| V2 Authentication | ✅ | ⚠️ | L1 met; L2 needs customer MFA |
| V3 Session Management | ✅ | ✅ | 256-bit tokens, hashed at rest, all-session-drop on reset |
| V4 Access Control | ✅ | ✅ | Two-tier middleware; explicit gates |
| V5 Validation, Sanitization, Encoding | ✅ | ✅ | Zod on every endpoint |
| V6 Stored Cryptography | ✅ | ✅ | Argon2id, AES, encrypted-at-rest |
| V7 Error Handling and Logging | ✅ | ✅ | RFC 9457 + Pino + PII redaction |
| V8 Data Protection | ✅ | ✅ | GDPR-aligned (Art. 32) |
| V9 Communications Security | ✅ | ✅ | TLS 1.3, HSTS preload, uniform strict CSP per ARCHITECTURE.md §5.2 |
| V10 Malicious Code | ⚠️ | ❌ | SCA yes; SAST no |
| V11 Business Logic | ✅ | ✅ | Idempotency, expand-contract, snapshots |
| V12 Files and Resources | ✅ | ✅ | S3 presigned URLs, MIME validation, size caps |
| V13 API and Web Service | ✅ | ✅ | Hono + zod-openapi + RFC 9457 |
| V14 Configuration | ✅ | ✅ | Parameter Store, no hardcoded secrets |

**Net:** L1-compliant today. **L2 gaps: customer MFA + SAST.** Both
addressable per §15.

---

## 6. NIST SP 800-63B-4 — Digital Identity

2024 revision of NIST's identity guidelines. Key changes from
800-63B-3: deprecates composition rules in favour of length +
breach-list checks.

| Requirement | Status | Notes |
|---|---|---|
| Memorised secret minimum 8 characters | ✅ | |
| Memorised secret max 64+ characters | ✅ | (implicit; no upper cap enforced) |
| Argon2id or equivalent for storage | ✅ | RFC 9106 compliant |
| Composition rules (upper/lower/digit) DEPRECATED | ⚠️ | Project still enforces. Fix: §15 item 17 |
| Breach-list check (HIBP k-anonymity) | ❌ | Fix: §15 item 15 |
| Single-use, time-bound recovery tokens | ✅ | 1-hour validity, SHA-256-hashed |
| Drop sessions on password change | ✅ | All-session-drop |
| Out-of-band notification at email change | ✅ | Old + new addresses notified |
| AAL1 for customer accounts | ✅ | Password + cookie session |
| AAL2 for admin via TOTP MFA | ✅ | RFC 6238 |

---

## 7. NIST SP 800-207 — Zero Trust Architecture

Finalized August 2020; SP 800-207A (multi-cloud) followed. Seven
tenets:

| Tenet | Status | Notes |
|---|---|---|
| All data sources and computing services are considered resources | ✅ | API + DB treated as resources |
| All communication is secured regardless of network location | ✅ | TLS 1.3 everywhere, including Lambda → Neon |
| Access to individual enterprise resources is granted on a per-session basis | ✅ | Cookies are short-lived; sessions revocable |
| Access to resources is determined by dynamic policy | ⚠️ | Static IAM policies; no risk-adaptive auth |
| The enterprise monitors and measures the integrity and security posture of all owned and associated assets | ⚠️ | CloudWatch alarms + Dependabot; no distributed tracing |
| All resource authentication and authorization are dynamic and strictly enforced before access is allowed | ✅ | Per-request `currentUser` / `requireAuth` |
| The enterprise collects information about asset state, network/communications, and uses it to improve security posture | ⚠️ | Pino logs collected; not yet analysed at security-event level |

**Net:** Zero Trust *spirit* respected; full ZTA tooling (policy
decision point, policy enforcement point, identity-aware proxy)
is overkill at solo-project scale.

---

## 8. SLSA v1.1 — Supply-chain Levels for Software Artifacts

| Level | Requirements | Status |
|---|---|---|
| Level 0 | No requirements | ✅ |
| Level 1 | Provenance exists describing how the package was built | ✅ |
| Level 2 | Provenance digitally signed by hosted build platform | ✅ Achieved May 2026 |
| Level 3 | Build platform isolates runs; secrets are not accessible to user-defined steps | ❌ Not pursued (see below) |

**SLSA Level 2 — how achieved:**
- `@cyclonedx/cyclonedx-npm@^2.0.0` produces a CycloneDX 1.6 JSON
  SBOM per workspace per build (`.github/workflows/sbom.yml`).
- `actions/attest-build-provenance@v4.1.0` signs each SBOM using
  GitHub Actions' OIDC token → Sigstore Fulcio short-lived cert →
  Rekor transparency log. No long-lived keys.
- SBOMs are attached to GitHub Releases as assets; their
  attestations are queryable via `gh attestation list`.
- Verification procedure for downstream consumers is documented in
  ARCHITECTURE.md §9.5.

**Level 3 is intentionally not pursued.** It would require a
reusable workflow with build-platform isolation (e.g. via
`slsa-framework/slsa-github-generator`). The marginal security gain
over L2 doesn't justify the operational complexity for a
single-tenant e-commerce shop with no third-party consumers of
build artifacts. Revisit when a customer contract requires it.

---

## 9. CIS Controls v8.1 — Implementation Group 1 (IG1)

IG1 = 56 cybersecurity safeguards. Designed as the floor for small
businesses with limited IT resources. Status across the 18 control
families:

| Control | Status |
|---|---|
| CIS 1 Inventory of Enterprise Assets | ⚠️ No formal inventory doc (ARCHITECTURE.md §15 item 22) |
| CIS 2 Inventory of Software Assets | ✅ Signed CycloneDX SBOM per workspace, attached to releases |
| CIS 3 Data Protection | ✅ |
| CIS 4 Secure Configuration of Enterprise Assets and Software | ✅ |
| CIS 5 Account Management | ✅ |
| CIS 6 Access Control Management | ✅ |
| CIS 7 Continuous Vulnerability Management | ✅ Dependabot + CodeQL `security-extended` weekly + on every PR |
| CIS 8 Audit Log Management | ⚠️ Pino logs yes; SIEM no — acceptable at this scale |
| CIS 9 Email and Web Browser Protections | N/A (no email clients) |
| CIS 10 Malware Defenses | N/A (no end-user devices in scope) |
| CIS 11 Data Recovery | ⚠️ Procedures yes; drill cadence no |
| CIS 12 Network Infrastructure Management | ✅ |
| CIS 13 Network Monitoring and Defense | ⚠️ WAF yes; full IDS no — acceptable |
| CIS 14 Security Awareness and Skills Training | N/A (solo project) |
| CIS 15 Service Provider Management | ✅ |
| CIS 16 Application Software Security | ✅ CodeQL SAST + signed SBOM + RFC 9116 VDP |
| CIS 17 Incident Response Management | ❌ No playbook |
| CIS 18 Penetration Testing | N/A at this scale |

---

## 10. GDPR

Bulgarian shop selling to EU residents — full GDPR scope.

| Article | Requirement | Status |
|---|---|---|
| Art. 5 | Lawfulness, fairness, transparency | ✅ Privacy policy + cookie consent |
| Art. 5(1)(c) | Data minimisation | ✅ Only collects required fields per account type |
| Art. 5(1)(e) | Storage limitation | ⚠️ No formal retention sweep for old `login_attempts` |
| Art. 6 | Lawful basis | ✅ Contract + legitimate interest + consent |
| Art. 7 | Conditions for consent | ✅ Cookie consent UI, distinct refuse-all button |
| Art. 12 | Transparent information | ✅ Privacy policy + clear UI copy |
| Art. 15 | Right of access | ✅ JSON export from profile |
| Art. 16 | Right to rectification | ✅ Profile-page editing |
| Art. 17 | Right to erasure | ✅ Delete-account flow with active-order check |
| Art. 18 | Right to restriction | ⚠️ No explicit "freeze processing" flow |
| Art. 20 | Right to data portability | ✅ JSON export |
| Art. 21 | Right to object | ⚠️ Marketing-consent rejection works; broader object-to-processing flow not built |
| Art. 25 | Privacy by design | ✅ PII redaction in logs; pseudonymised session tokens |
| Art. 32 | Security of processing | ✅ Encryption at rest + in transit + audit log |
| Art. 33 | Breach notification to supervisory authority within 72h | ⚠️ No playbook documented |
| Art. 34 | Communication of breach to data subject | ⚠️ No playbook documented |
| Art. 35 | Data Protection Impact Assessment | N/A (low-risk processing of basic identifying info) |
| Art. 44 | Data residency | ✅ All processing in `eu-central-1` |

---

## 11. EU Cyber Resilience Act

Effective dates:
- **September 11, 2026** — manufacturers must report actively
  exploited vulnerabilities within 24 hours to ENISA + national
  CSIRTs.
- **December 11, 2027** — full compliance deadline (SBOM,
  vulnerability handling, security updates for 5 years).

The CRA targets "products with digital elements." Pure SaaS is
**arguably out of scope** — the regulation specifically applies to
physical or downloadable products placed on the market. The
Commission has signalled SaaS will be addressed separately.

**Recommended posture:** adopt CRA-style hygiene even though it
likely doesn't apply legally. The reputational and customer-trust
benefits are real, and the technical requirements (SBOM, vuln
disclosure policy, 24h reporting practice) are also driven by
NIST CSF 2.0 and OWASP Top 10 2025.

| CRA-style practice | Status | Driven by |
|---|---|---|
| SBOM published | ✅ CycloneDX 1.6 per workspace, signed, attached to releases | NIST CSF, OWASP 2025 |
| Vulnerability disclosure policy (`security.txt`) | ✅ `frontend/public/.well-known/security.txt` + bilingual `/security` policy page | RFC 9116 |
| Vulnerability handling process | ✅ Dependabot + CodeQL + 72h-ack / 90d-fix commitment in VDP | OWASP, NIST |
| Documented 24h breach reporting | ⚠️ Playbook still pending (ARCHITECTURE.md §15 item 21) | GDPR Art. 33 |
| Security updates available for 5+ years | ⚠️ Yes for managed AWS; OS not applicable | CRA |

---

## 12. EU Directive 2023/2673 — 14-day right of withdrawal

Mandatory in all EU member states from **June 19, 2026**.

| Requirement | Status |
|---|---|
| "Withdrawal button" clearly labelled | ✅ "Откажете се от договора тук" |
| Easy to find | ✅ Linked from order detail, footer, /terms, /delivery |
| Confirmation receipt on durable medium (Art. 11a(2)) | ✅ On-screen receipt + email |
| Receipt includes date/time of withdrawal | ✅ Sofia timezone, second precision |
| No dark patterns (recital 37) | ✅ No double-confirm, no countdown, no upsell |
| Optional reason | ✅ Marked "по избор" |
| Penalty for missing button | Window extends to 12 months + 14 days |

Implemented in the May 2026 withdrawal slice. Full coverage.

---

## 13. WCAG 2.2 / European Accessibility Act

European Accessibility Act mandatory since **June 28, 2025** for
e-commerce serving EU residents.

| WCAG 2.2 Principle | Status |
|---|---|
| Perceivable (alt text, contrast 4.5:1, info not by colour alone) | ✅ In scope per docs/README §13 |
| Operable (keyboard nav, focus indicators, 24×24 touch targets, skip nav) | ✅ |
| Understandable (labels, error messages, autocomplete, predictable navigation) | ✅ |
| Robust (semantic HTML, ARIA, screen-reader compatibility) | ✅ |

WCAG 2.2 AA is the European Accessibility Act baseline. The
functional spec commits to it; ongoing audit (via tools like axe-
core in CI) is the gap, not the design intent.

---

## 14. Standards justified as out of scope

| Standard | Why out of scope |
|---|---|
| **PCI-DSS** | No PAN (cardholder data) is received, stored, or transmitted. Payment is cash on delivery / pay at store only. |
| **NIS2 Directive** | Applies to "important entities" defined by revenue/employee thresholds. The shop's scale is below those thresholds. Reassess if annual revenue exceeds ~€10M or employee count exceeds ~50. |
| **SOC 2 Type 2** | Audit framework primarily relevant for B2B SaaS with enterprise customers requiring attestation. Not relevant for B2C e-commerce. Would become relevant if the project pivoted to multi-tenant SaaS. |
| **ISO 27001** | Information security management certification. Useful for organisations with employees and physical premises; overhead exceeds value for a solo project. |
| **HIPAA** | US healthcare. No medical data. |
| **EU AI Act** | No AI / ML systems in the architecture as of May 2026. |
| **PSD2** | Payment services regulation. Payment is cash-on-delivery / pay-at-store — out of scope. |

If any of these become in-scope (e.g., project pivots, scale
crosses NIS2 thresholds, B2B customer requires SOC 2 attestation),
update this matrix and add the relevant gaps to
`ARCHITECTURE.md` §15.

---

*Auditor-facing reference. The narrative explanation of each
gap and its remediation lives in `ARCHITECTURE.md` (§14
"Honest assessment" and §15 "Roadmap to A+").*
