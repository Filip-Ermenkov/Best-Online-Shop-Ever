# Incident Response — Best Online Shop Ever

> The operational playbook for detecting, triaging, containing, and
> learning from incidents — and the legally load-bearing procedure for
> handling a **personal-data breach** under GDPR Art. 33/34 with the
> Bulgarian supervisory authority (CPDP / КЗЛД).
>
> Companion docs: `ARCHITECTURE.md` (§6 reliability, §11 operations,
> §12 disaster recovery, §3.10 alarms — this doc is the *umbrella* that
> calls those *procedures*); `COMPLIANCE.md` (the standards matrix this
> doc closes rows in — NIST CSF 2.0 Respond/Recover, CIS Control 17,
> GDPR Art. 33/34); `infra/README.md` (the email-queue, scheduler,
> tracing, and SLO + burn-rate runbooks referenced below).
>
> Standards anchored: **NIST SP 800-61r3** (April 2025 — the incident-
> response lifecycle re-expressed against the six NIST CSF 2.0
> functions), **NIST CSF 2.0** Respond (RS) + Recover (RC), **GDPR
> Art. 33–34** (+ EDPB Guidelines 9/2022 breach taxonomy), and **CIS
> Controls v8.1 Control 17**.
>
> Last updated: 2026-06-15. **Status: pre-deployment.** This playbook is
> deliberately written *before* the first incident and *before* the
> maintained production environment exists (Roadmap item 17). The
> human-decision parts (triage, breach assessment, communication) are
> usable today; the automated-detection parts (CloudWatch alarms, SLO
> burn-rate pages) only fire once the stack is deployed with an
> `alarm_email` subscription and `log_level = "info"` — see §2.3.

---

## Contents

1. [Scope, principles, and the single-operator model](#1-scope-principles-and-the-single-operator-model)
2. [Before an incident (Prepare — CSF Govern / Identify / Protect)](#2-before-an-incident-prepare--csf-govern--identify--protect)
3. [Severity classification (SEV1–SEV4)](#3-severity-classification-sev1sev4)
4. [The incident lifecycle](#4-the-incident-lifecycle)
5. [Scenario playbooks](#5-scenario-playbooks)
6. [Personal-data breach — the GDPR Art. 33/34 track](#6-personal-data-breach--the-gdpr-art-3334-track)
7. [Communication](#7-communication)
8. [After the incident — the blameless postmortem](#8-after-the-incident--the-blameless-postmortem)
9. [The breach register (Art. 33(5) accountability)](#9-the-breach-register-art-335-accountability)
10. [Evidence and forensics sources](#10-evidence-and-forensics-sources)
11. [Drills and maintenance](#11-drills-and-maintenance)
12. [Appendices — copy-paste templates](#12-appendices--copy-paste-templates)

---

## 1. Scope, principles, and the single-operator model

An **incident** is any unplanned event that degrades — or threatens to
degrade — the shop's availability, integrity, confidentiality, or legal
standing. Concretely: the shop is down or erroring; checkout is failing;
the database is unreachable; the admin account is compromised; durable-
medium emails are not being delivered; or **personal data has been
exposed, altered, or lost**. A near-miss that *could* have caused any of
those is also worth a lightweight write-up.

This is **not** every bug. A typo in a product description is a normal
chore. Use the severity table in §3 to decide whether the playbook
applies; when in doubt, treat it as a low-severity incident and at least
make a timeline note — under-reacting to a real incident is far more
expensive than over-reacting to a false alarm.

### 1.1 Principles

- **Blameless.** Incidents are caused by systems and conditions, not
  bad people. Every postmortem (§8) interrogates the *system* that let
  the failure happen, never the human who tripped it. This is the only
  culture that keeps people reporting problems early.
- **Write it down as it happens.** Start a timeline the moment you
  suspect an incident — timestamps, what you saw, what you did. Memory
  is unreliable and the GDPR 72-hour clock (§6) makes a contemporaneous
  record legally valuable. Don't wait for full information to start
  recording.
- **Stop the bleeding before you find the cause.** Containment and
  recovery (restore service) come *before* root-cause analysis. The
  postmortem is where you understand *why*; the incident is where you
  make it stop.
- **Preserve evidence while you contain.** Especially for a suspected
  breach — a Neon point-in-time branch (§10) freezes a forensic copy so
  containment actions don't destroy the audit trail.
- **The first incident with no postmortem is the start of a culture of
  forgetting** (echoing `ARCHITECTURE.md` §11). Every SEV1/SEV2 and
  every personal-data breach gets a postmortem, no exceptions.

### 1.2 The single-operator reality

The shop is **single-admin by design** (`ARCHITECTURE.md` §13). The
classic incident-response role split — Incident Commander, Communications
Lead, Operations Lead, Scribe — collapses onto **one person**. This
playbook compensates for the missing headcount with *checklists and
templates*, not org charts: the value of naming those roles here is the
**checklist each one implies**, which the single operator runs in
sequence rather than in parallel.

Two corollaries the operator must plan around:

- **You are a single point of failure for response, too.** Document
  where the "go-bag" lives (§2.1) so a trusted delegate or external
  contractor could step in if you are unavailable during an incident.
- **Know when to escalate outward.** You do not have a security team;
  your escalation path is *external* — Neon support, AWS Support, the
  domain registrar, and — for a personal-data breach — a data-protection
  lawyer or DPO and the CPDP itself. Pre-stage those contacts (§2.2)
  before you need them.

### 1.3 How this doc relates to the runbooks

This playbook is the **decision layer**: detect → classify → decide what
to do. The **procedures** it dispatches to already live elsewhere, and
this doc does not duplicate them:

| When you need to… | Go to |
|---|---|
| Restore the database to a point in time | `ARCHITECTURE.md` §12.2 (Neon PITR) |
| Recover a lost/compromised admin MFA seed | `ARCHITECTURE.md` §12.4 (scenarios A/B/C + break-glass SQL) |
| Restore the catalog from an S3 backup | `ARCHITECTURE.md` §12.3 |
| Redrive stuck durable-medium emails | `infra/README.md` → "Durable email queue" |
| Read the SLO burn-rate alarms | `infra/README.md` → "SLO + burn-rate runbook" |
| Pivot from an alarm to a trace to logs | `infra/README.md` → "Tracing runbook" |
| Understand a specific failure mode | `ARCHITECTURE.md` §6.1 (failure-mode table) |

---

## 2. Before an incident (Prepare — CSF Govern / Identify / Protect)

NIST SP 800-61r3 folds preparation into the CSF **Govern**, **Identify**,
and **Protect** functions: most of the project already lives there
(threat model §5.1, hardened auth, strict CSP, SLSA L2, backups). This
section is the **response-readiness** subset — the things that must be
true *before* an alarm fires so that response is fast instead of frantic.

### 2.1 The go-bag

Assemble these once and keep them **out of the git repository** (the
same discipline `ARCHITECTURE.md` §12.4.1 applies to the admin MFA seed —
never in the repo, any chat history, email, or a cloud service the admin
account itself controls):

- This playbook (a printed or offline copy — an incident may be *why*
  you can't reach the hosted copy).
- The contacts sheet (§2.2).
- Paths to credentials: the AWS root/break-glass channel (hardware-MFA-
  protected), the Neon console login, the domain registrar, the admin
  recovery codes (paper, in a safe), and the password-manager vault.
- The break-glass SQL for MFA reset (`ARCHITECTURE.md` §12.4.4) and for
  mass session revocation (§5.5 below).

### 2.2 Contacts sheet (fill in before deploying)

Keep the filled copy in the go-bag, not here. Template:

| Role | Who / where | Channel | Notes |
|---|---|---|---|
| Operator (IC) | *(you)* | — | Single admin |
| Backup operator / delegate | *(name)* | *(phone)* | Can step in if you're unreachable |
| AWS Support | Console → Support Center | Web case | Plan tier dictates response SLA — note the tier |
| Neon Support | Neon console | Web / email | Check `status.neon.tech` first |
| Domain registrar | *(registrar)* | *(login)* | DNS / TLS emergencies |
| Data-protection lawyer / DPO | *(name)* | *(phone/email)* | Engage on any suspected breach |
| **CPDP (КЗЛД)** — supervisory authority | Sofia 1592, 2 Prof. Tsvetan Lazarov blvd. | `kzld@cpdp.bg` (qualified e-signature) or the Secure Electronic Delivery System (Ministry of e-Government) | The Art. 33 notification destination — see §6.4 |
| SES / deliverability | AWS SES console | — | Reputation tab, bounce/complaint rates |

### 2.3 Detection sources (what tells you something is wrong)

Detection is the CSF **Detect** function; tracing (item 18) and SLO
burn-rate alarms (items 24/25) shipped specifically to make it strong.
The sources, by how you find out:

**Automated (active once deployed — see the activation checklist below):**

| Source | Fires when | Defined in |
|---|---|---|
| `api-5xx-rate` alarm | shop-api 5xx > 1% over 5 min | `infra/observability.tf` |
| SLO **availability** burn-rate | fast-burn (1h/5m @ 14.4×) → **page**; slow-burn (6h/30m @ 6×) → ticket | `infra/slo.tf` |
| SLO **order-success** burn-rate | POST /orders 5xx fast-burn → **page** | `infra/slo.tf` |
| SLO **p95 latency** guard | p95 > 1000 ms over 15 min | `infra/slo.tf` |
| Lambda **p99 duration** alarm | p99 > 5 s | `infra/observability.tf` |
| `email-dlq-depth` / `email-queue-age` | a durable email exhausted retries / consumer not draining | `infra/sqs.tf` |
| `scheduler-fn-errors` / delivery-failures | a cron job threw / could not be delivered | `infra/scheduler.tf` |
| SES bounce-rate alarm | bounce > 5% | `infra/observability.tf` |
| admin-login-failures | > 5 failed admin logins/hour | `infra/observability.tf` |

**Human / external:** a customer report; `POST /csp-report` violation
spikes (possible XSS attempt — `ARCHITECTURE.md` §5.2.3); `status.neon.tech`;
the AWS Health Dashboard; a Dependabot/CodeQL alert (a supply-chain or
code-level finding); a security researcher using the `/security` VDP
contact (RFC 9116).

**Activation checklist (do these with the item-17 deploy so detection is real):**

- [ ] Subscribe a monitored inbox to the alarms' SNS topic (`alarm_email`).
- [ ] Set `log_level = "info"` so the SLI metric filters see `request_end` (a `slo.tf` precondition enforces this when `enable_slo_alarms = true`).
- [ ] Set `enable_slo_alarms = true` and drive enough traffic to make the budgets meaningful.
- [ ] Confirm at least one alarm round-trips to the inbox (cause a controlled 5xx, watch the email land) — an untested alert path is not a detection control.

---

## 3. Severity classification (SEV1–SEV4)

Classify on **impact**, not cause, and re-classify as you learn more.
Response times are realistic for a single operator — they describe *how
fast you drop other work*, not a paid on-call SLA.

| Level | Criteria | This shop's examples | Drop-everything? |
|---|---|---|---|
| **SEV1** | Service down or unusable for ~all users; or a confirmed security/data compromise | Shop returns 5xx site-wide; checkout fails for everyone; Neon outage; **admin account compromised**; **confirmed personal-data breach** | **Immediately**, any hour |
| **SEV2** | A major flow degraded for many users; or a *suspected* breach under assessment | Checkout failing for a subset; login broken; search down; durable emails not sending and the DLQ is filling; suspected breach not yet confirmed | Within the hour |
| **SEV3** | A minor feature impaired, or a contained/slow-burn issue | Order-status emails delayed; one cron job failing; elevated latency under the SLO page threshold; CSP-report spike to investigate | Same day |
| **SEV4** | Cosmetic or low-impact | A broken image, a copy bug, a single non-critical alarm flap | Next working day |

Two rules that override the table:

- **A personal-data breach is tracked on its own axis.** Even a "small"
  confidentiality breach triggers the legal track in §6 with its **own
  72-hour clock**, regardless of the availability-severity you assign.
  When in doubt, run the §6 assessment.
- **Escalate severity on uncertainty, de-escalate on evidence.** Start a
  suspected breach at SEV2 (assessment in progress) and move it to SEV1
  only if confirmed high-risk — but never let "I'm not sure yet" keep you
  at SEV3.

---

## 4. The incident lifecycle

NIST SP 800-61r3 (2025) replaced the old four-phase model with a
lifecycle expressed against the CSF 2.0 functions. The practical loop
for this shop, with the function each step serves:

```
 DETECT ─► TRIAGE ─► CONTAIN ─► ERADICATE ─► RECOVER ─► LEARN
 (Detect)  (Respond)  (Respond)   (Respond)   (Recover)  (Improve)
                          │
                          └─►  if personal data is involved, run the
                               §6 GDPR track IN PARALLEL (its own clock)
```

### 4.1 Detect

A signal arrives (§2.3). Acknowledge it, open a timeline note with the
UTC and Europe/Sofia time, and write the one-line "what I'm seeing."

### 4.2 Triage

Decide severity (§3) and find the failing layer fast. Use the standing
triage order from `ARCHITECTURE.md` §11, expanded:

1. **Database?** `npm run db:psql` → `SELECT 1`; check `status.neon.tech`.
   The most common hard-down cause. `currentUser` deliberately does *not*
   clear cookies on DB errors (§6.1), so a Neon blip logs users out of
   nothing.
2. **shop-api Lambda?** CloudWatch Logs for the function → filter by
   `X-Request-Id` (and, with tracing on, pivot to the X-Ray trace —
   `infra/README.md` "Tracing runbook"). Read the `request_end` lines.
3. **Frontend?** Amplify build history — a bad deploy stays *isolated*
   because Amplify deploys are atomic (the previous version stays live).
4. **Edge?** CloudFront status; WAF rule firing-rate if enabled.
5. **Email?** SES console reputation tab; SQS queue + DLQ depth.

Ask immediately: **is personal data exposed, altered, or lost?** If
plausibly yes, start the §6 track *now* — the 72-hour clock starts at
awareness, not at confirmation.

### 4.3 Contain

Stop the spread without destroying evidence (§10). Containment is
scenario-specific (§5): roll back a bad deploy, revoke sessions, disable
a feature flag, fail a poisoned message to the DLQ, or rotate a leaked
secret. Prefer **reversible** containment; if you must take a
destructive action, snapshot first (Neon PITR branch).

### 4.4 Eradicate

Remove the root cause: ship the fix, patch the dependency, rotate the
compromised credential for good, purge the bad data. For code, this goes
through the normal `feat(scope):` branch → PR → squash-merge path unless
SEV1 justifies an emergency hotfix (which still gets a same-day PR for
the record).

### 4.5 Recover

Restore normal service and **verify** it. Dispatch to the right runbook:
DB → `ARCHITECTURE.md` §12.2; catalog → §12.3; email backlog → the
email-queue redrive. Watch the relevant alarm clear and confirm a real
user path works (place a test order; load the storefront).

### 4.6 Learn

Within a few days, write the blameless postmortem (§8) and file its
action items. For a breach, the postmortem includes the regulatory
record (§6, §9).

---

## 5. Scenario playbooks

Concrete first-30-minutes guides for this shop's realistic incidents.
Each: the **signal**, **immediate actions**, the **runbook** to dispatch
to, and a **severity hint**. They assume the maintained deploy exists;
before that, they are dry-run reading.

### 5.1 Shop-api 5xx surge / API down

- **Signal:** `api-5xx-rate` alarm and/or the SLO **availability** fast-
  burn page; customers report errors.
- **Immediate:** Triage order §4.2 (DB first — a Neon outage surfaces
  here as 5xx). If the DB is healthy, read recent `request_end` /
  `app.onError` log lines by `X-Request-Id`; pivot to the trace. If a
  recent deploy correlates, **roll back**: `aws lambda
  update-function-code` to the previous artifact (or re-point the alias).
- **Runbook:** `infra/README.md` "Tracing runbook" to pivot alarm→trace→logs.
- **Severity:** SEV1 if site-wide; SEV2 if a subset.
- **Note:** the SLO availability SLI reads the *actual* HTTP status from
  the log, so it catches the graceful 5xx that `app.onError` returns —
  ones the Lambda-`Errors`-based `api-5xx-rate` alarm misses
  (`ARCHITECTURE.md` §8.5). Trust the SLO signal.

### 5.2 Database outage / degradation (Neon)

- **Signal:** 5xx surge tracing back to DB calls; `status.neon.tech`.
- **Immediate:** Confirm via `db:psql` `SELECT 1`. If Neon is down and
  you're on Launch, this is wait-or-upgrade; on Scale it should auto-fail
  over in seconds (§6.1). For **logical** loss (a bad migration, an
  accidental `DELETE`), do **not** keep writing — go to PITR.
- **Runbook:** `ARCHITECTURE.md` §12.2 (create a PITR branch, verify row
  counts, switch the SSM `DATABASE_URL`, redeploy/bounce, verify).
- **Severity:** SEV1 (hard down) / SEV2 (degraded).

### 5.3 Checkout / order-placement failures

- **Signal:** SLO **order-success** fast-burn page; `POST /orders` 5xx in
  logs; customer reports.
- **Immediate:** Check the DB (the checkout transaction does `SELECT …
  FOR UPDATE OF products`); look for lock contention, stock/price re-check
  failures, or idempotency conflicts. Orders are durable the moment the
  transaction commits — a *failed email* never means a failed order
  (best-effort sends, §3.7), so don't conflate the two.
- **Severity:** SEV1 — checkout is the revenue path.

### 5.4 Durable email not being delivered

- **Signal:** `email-dlq-depth > 0` or `email-queue-age > 15 min`; SES
  bounce alarm.
- **Immediate:** The order/account operation already succeeded (emails
  are best-effort and the queue is durable — an SES outage *delays*,
  it does not *drop*). Inspect the DLQ, fix the cause (e.g. a broken
  `EMAIL_FROM`, an unverified sender, an SES sending-pause), then
  **redrive**.
- **Runbook:** `infra/README.md` "Durable email queue" (DLQ inspect →
  fix → redrive). For compliance-bearing mail (order confirmation,
  withdrawal receipt), note the delay in the timeline — it touches the EU
  2023/2673 durable-medium margin (§6 if a pattern of loss, not delay).
- **Severity:** SEV3 normally; SEV2 if the DLQ is filling fast or
  confirmations are being lost rather than delayed.

### 5.5 Admin account compromise / suspicious admin activity

- **Signal:** `admin-login-failures` alarm; an `admin_audit_log` entry
  you did not make; an unexpected order-status change or data export.
- **Immediate (treat as SEV1 security):**
  1. **Revoke all sessions** — `db:psql`:
     `UPDATE sessions SET revoked_at = now();` (mass invalidation, per
     `ARCHITECTURE.md` §6.1). This logs out the attacker *and* you.
  2. **Rotate admin credentials** — reset the admin password; rotate the
     TOTP seed (Admin → Security, once back in) and the
     `ADMIN_MFA_ENCRYPTION_KEY` / `ADMIN_MFA_CHALLENGE_KEY` in SSM.
  3. **Preserve evidence** — snapshot a Neon PITR branch (§10) before any
     cleanup; export the relevant `admin_audit_log` rows.
  4. **Assess data exposure** — the admin can read all customer data, so a
     real admin compromise is almost certainly a **personal-data breach →
     run §6**.
- **Lost MFA (not compromise):** `ARCHITECTURE.md` §12.4 scenarios A/B/C.
- **Severity:** SEV1.

### 5.6 Suspected personal-data breach

- **Signal:** any of the above with PII exposure; a researcher report; a
  leaked credential; data found where it shouldn't be.
- **Immediate:** **Go to §6 and start the 72-hour clock.** Contain
  (revoke, rotate, take offline) *and* preserve evidence in parallel.
- **Severity:** SEV1/SEV2 on the breach axis (§3).

### 5.7 Dependency / code vulnerability (supply chain)

- **Signal:** Dependabot alert, CodeQL `security-extended` finding, or a
  CVE in a dependency the SBOM lists.
- **Immediate:** Assess exploitability *in this app's context* (a CVE in
  an unused code path may be SEV4). Patch via the normal PR path; for an
  actively-exploited RCE in a reachable path, treat as SEV1 and hotfix.
  The signed CycloneDX SBOMs (§9.5 of ARCHITECTURE) let you confirm which
  deployable is affected.
- **Severity:** scales with exploitability and reachability.

### 5.8 Catalog corruption / bad bulk edit

- **Signal:** wrong prices/categories live; a bad import.
- **Immediate:** Order **line items are snapshotted at checkout**
  (`ARCHITECTURE.md` §13), so historical orders are safe regardless. For an
  accidental single delete, **restore the product/category from the admin Archive
  page** (`/admin/archive`, item 51). Before a risky bulk edit, take an on-demand
  snapshot from the same page („Направи архив сега"). For wholesale corruption,
  restore from the daily (or that manual) S3 backup.
- **Runbook:** `ARCHITECTURE.md` §12.3. The admin Archive page lists the
  `catalog_backups` snapshots, takes on-demand backups, restores individual
  soft-deleted products/categories (item 51), AND — since item 52 (2026-07-08) —
  restores a **whole snapshot** over the live catalog: pick a snapshot → **Възстанови**
  → read the dry-run **preview** (it names the newer rows that will be archived) →
  type „ВЪЗСТАНОВИ" → confirm. The restore takes an automatic pre-restore safety
  backup first (so it is reversible — restore *that* snapshot to roll back) and
  replays atomically. The old "read the dated S3 object and replay it by hand in
  psql" step is retired. Orders are safe regardless (line-item snapshots).
- **Severity:** SEV2/SEV3 (no order-history risk).

---

## 6. Personal-data breach — the GDPR Art. 33/34 track

This is the part of the playbook with a **legal deadline**. It runs *in
parallel* with the technical lifecycle (§4): you contain and recover the
system while you assess and, if required, notify. The shop is a Bulgarian
data **controller**, so the supervisory authority is the **CPDP / КЗЛД**
(Commission for Personal Data Protection / Комисия за защита на личните
данни).

### 6.1 What is a personal-data breach

Per GDPR Art. 4(12) and EDPB Guidelines 9/2022, a personal-data breach is
a breach of security leading to the accidental or unlawful
**destruction, loss, alteration, unauthorised disclosure of, or access
to** personal data. The EDPB taxonomy gives three (often overlapping)
types — use it to frame the risk:

- **Confidentiality breach** — unauthorised *disclosure of* or *access
  to* data (e.g. a leaked DB credential, an exposed export, an admin
  compromise). The most likely type for this shop.
- **Integrity breach** — unauthorised *alteration* of data.
- **Availability breach** — accidental/unlawful *loss of access to* or
  *destruction of* data (e.g. data lost beyond the Neon PITR window with
  no backup).

A breach can be more than one at once. **An availability breach
counts** — losing data, not just leaking it, is notifiable.

### 6.2 What personal data this shop holds (your exposure map)

Knowing the blast radius up front makes the risk assessment fast:

| Data | Where | At-rest protection (lowers breach risk) |
|---|---|---|
| Account email, role, account type | `users` | — |
| Password | `users.password_hash` | **Argon2id** (RFC 9106) — not reversible |
| Admin TOTP secret | `users.mfa_secret_encrypted` | **AES-256-GCM**, key in SSM only (DB never sees it) |
| Verification/reset/email-change tokens | `*_tokens` | **SHA-256** hashed; single-use |
| Profile (name, phone, company, VAT/EIK) | profile tables | — |
| Address book + order delivery snapshots | `addresses`, `order_delivery_address` | — |
| Order history + line snapshots | `orders`, `order_items` | — |
| Guest order contact (email, name, phone) | `orders` (NULL `customer_id`) | — — same PII categories as account orders, just no account; reachable via the order's `guest_track_token` capability URL (256-bit, plaintext at rest by design — see `ARCHITECTURE.md` §13). A token leak exposes one order's contact data + the cancel/withdrawal actions, never an account |
| Login telemetry (IP, UA) | `login_attempts` | 180-day retention prune (item 23) |
| Cookie-consent receipts (IP, UA, `visitor_id`) | `cookie_consents` | opaque visitor id, no account link |
| Admin actions (actor, IP, UA, diffs) | `admin_audit_log` | append-only — also your forensic source (§10) |

**The single biggest risk-reducer is what is *not* here: no card data.**
Cash-on-delivery / pay-at-store means there is no PAN, CVV, or cardholder
data to breach (`ARCHITECTURE.md` §1) — the highest-severity breach class
for most shops simply does not exist here. The Argon2id/AES-GCM/SHA-256
protections above are exactly the "appropriate technical measures …
particularly encryption" that can make a breach **non-high-risk** under
Art. 34(3)(a) (see §6.5).

### 6.3 The decision tree

```
A security event touched personal data.
│
├─ 1. Is it a personal-data breach? (confidentiality / integrity /
│      availability — §6.1)
│         NO  ─► not an Art.33 event. Still log a timeline note.
│         YES ─► ►► THE 72-HOUR CLOCK STARTS AT THIS MOMENT OF AWARENESS ◄◄
│
├─ 2. Record it in the BREACH REGISTER (§9). Art. 33(5) requires you to
│      document EVERY breach — even ones you end up not notifying.
│
├─ 3. Risk assessment: is it likely to result in a RISK to the rights
│      and freedoms of individuals? (consider data type, volume,
│      sensitivity, ease of identification, severity of consequence,
│      and whether the data was encrypted/hashed — §6.2)
│         UNLIKELY to risk ─► no CPDP notification required, BUT keep the
│                              register entry with your reasoning. Stop here.
│         LIKELY to risk   ─► 4.
│
├─ 4. NOTIFY THE CPDP within 72 hours of awareness (Art. 33) — §6.4.
│      Late? Notify anyway and state the reasons for delay.
│      Don't have all the facts? Notify in PHASES (Art. 33(4)).
│
└─ 5. Is it likely to result in a HIGH risk to individuals?
          NO  ─► done after CPDP notification + register.
          YES ─► ALSO notify the affected DATA SUBJECTS without undue
                 delay (Art. 34) — §6.6 — unless an Art. 34(3) exception
                 applies (§6.5).
```

### 6.4 Notifying the CPDP (Art. 33) — the Bulgarian specifics

- **Deadline:** without undue delay and **no later than 72 hours** after
  becoming aware. The clock starts at *awareness that a breach has likely
  occurred* — not when you finish the investigation.
- **Where to send it (CPDP / КЗЛД):**
  - In person or by post: **Sofia 1592, 2 Prof. Tsvetan Lazarov blvd.**
    (бул. „Проф. Цветан Лазаров" № 2).
  - Email: **`kzld@cpdp.bg`** — *signed with a qualified electronic
    signature*.
  - Via the **Secure Electronic Delivery System** of the Ministry of
    e-Government.
- **What to include (Art. 33(3) — minimum):**
  1. The **nature** of the breach, including, where possible, the
     **categories and approximate number** of data subjects and of
     personal-data records concerned.
  2. The **name and contact details** of the data-protection contact
     (DPO if appointed; otherwise the operator) where more information
     can be obtained.
  3. The **likely consequences** of the breach.
  4. The **measures taken or proposed** to address the breach and to
     mitigate possible adverse effects.
- **Phased notification (Art. 33(4)):** where the information cannot be
  provided at once, provide it in phases without undue further delay.
  Send what you have inside 72 hours; follow up.
- **If late:** notify anyway and accompany it with the **reasons for the
  delay**. A late notification beats a missing one.

Use the ready-to-fill template in **Appendix A**.

### 6.5 When you do NOT have to notify

- **CPDP (Art. 33):** if the breach is **unlikely to result in a risk**
  to individuals. Still log it in the register (§9) with your reasoning.
- **Data subjects (Art. 34(3) exceptions),** any one of:
  - **(a)** the data was protected by appropriate technical measures —
    **particularly encryption** — that render it unintelligible to
    anyone unauthorised (this is where Argon2id-hashed passwords,
    AES-GCM-encrypted TOTP secrets, and SHA-256-hashed tokens earn their
    keep — §6.2);
  - **(b)** you have since taken measures ensuring the high risk is **no
    longer likely** to materialise;
  - **(c)** it would involve **disproportionate effort** — in which case
    make a **public communication** instead (e.g. a notice on the site).

Document which exception you relied on, in the register.

### 6.6 Notifying data subjects (Art. 34)

Required only when the breach is likely to result in a **high risk**
(e.g. identity theft, fraud, financial loss, reputational damage,
significant social/economic disadvantage). Then, **without undue delay**:

- Communicate in **clear and plain language** (Bulgarian first, this is a
  Bulgarian-facing shop — see Appendix B for a BG/EN template).
- Include at least Art. 33(3) points **(b), (c), (d)** — the contact
  point, the likely consequences, and the measures taken/proposed.
- Reach the affected customers directly (email to the address on file)
  where feasible; otherwise the disproportionate-effort route → public
  communication.

### 6.7 Forward-looking: the Digital Omnibus proposal (not yet law)

As of June 2026 the EU's **Digital Omnibus** package is a *proposal,
not enacted*. If adopted it would (per the published draft) **extend the
Art. 33 deadline from 72 to 96 hours**, **raise the notification
threshold to "high risk" only** (aligning Art. 33 with Art. 34), and
introduce a **single EU entry point** for breach reporting across GDPR,
NIS2, eIDAS and DORA. **Until it is enacted, the 72-hour / risk-based
rule above is what binds.** Revisit this section when the Omnibus
becomes law.

---

## 7. Communication

Honest, factual, on a predictable cadence. Three audiences:

### 7.1 Internal / personal status log

Even solo, keep a running status entry per incident — it becomes the
postmortem timeline and the breach-register evidence. Use the **status
update** template (Appendix C): severity, status (Investigating /
Identified / Monitoring / Resolved), impact, actions taken, next steps,
and a timeline table. Update it when facts change, not on a timer.

### 7.2 Customers

- **No public status page yet** (Roadmap item 30). Until it exists, the
  interim channels are a **site banner** and, for an outage that affected
  orders, a follow-up email. Be factual: what happened, who was affected,
  what you did, what they should do (usually nothing).
- For a **high-risk breach**, customer communication is not optional —
  it is the Art. 34 notification (§6.6, Appendix B).
- Never speculate on cause in customer-facing copy while the incident is
  open. "We are investigating" is correct and sufficient.

### 7.3 The regulator (CPDP)

Only for a notifiable personal-data breach (§6.4). This is a formal
filing, not a status update — use Appendix A, send via a §6.4 channel,
and record the submission (date, time, reference) in the breach register.

---

## 8. After the incident — the blameless postmortem

**Required** for every SEV1, every SEV2, and **every personal-data
breach** (regardless of severity). Optional but encouraged for SEV3.
Write it within a few working days, while memory is fresh.

The discipline (NIST CSF **Improve** / CSF 2.0 ID.IM): reconstruct the
timeline, find the *systemic* root cause with **5 Whys**, and leave with
**action items that have an owner and a due date** — a postmortem with no
tracked actions is a diary entry, not a control.

- **Blameless:** the subject is always the system and the conditions,
  never the person. "The deploy had no smoke test" — not "X forgot to
  test."
- **Where it lives:** non-sensitive postmortems go in the repo under
  `docs/postmortems/YYYY-MM-DD-short-title.md` (create the folder on
  first use), with all PII and secrets redacted. A postmortem whose
  detail is itself sensitive (e.g. an unpatched-but-live vulnerability,
  or breach specifics) stays **out-of-band** with the go-bag until it is
  safe to publish.
- **Feed the loop:** action items flow back into the §15 roadmap /
  backlog; recurring causes update the threat model (`ARCHITECTURE.md`
  §5.1) at the yearly review (§11).

Template: **Appendix D**.

---

## 9. The breach register (Art. 33(5) accountability)

GDPR Art. 33(5) requires the controller to **document any personal-data
breach** — the facts, its effects, and the remedial action taken —
**whether or not it was notified** to the CPDP. This register is what
demonstrates compliance if the CPDP ever asks; the non-notified entries
(with your "unlikely to risk" reasoning) are as important as the notified
ones.

- **Keep it out of the public repo** — it contains incident detail and
  references to personal data. It lives with the go-bag (§2.1), same
  discipline as the MFA seed.
- **One row per breach**, append-only, with the format in **Appendix E**.
- Link each register entry to its postmortem (§8) and, if notified, to
  the CPDP submission reference and any Art. 34 customer communication.

---

## 10. Evidence and forensics sources

When investigating — and especially before any destructive containment —
know where the truth is and preserve it:

- **`admin_audit_log`** — append-only record of every state-changing
  admin action (actor, action, entity, before/after diff, IP, UA,
  timestamp). Built explicitly "for incident investigation, compliance,
  and to honour GDPR Art. 30." The first place to look for a compromised
  or misused admin session.
- **Structured Pino logs** (CloudWatch in prod) — PII-redacted, per-
  request child logger on `X-Request-Id`; `request_start` / `request_end`
  lines carry method, path, status, durationMs, and (tracing on)
  `trace_id` / `span_id`.
- **X-Ray traces** — pivot from any log line or alarm to the full
  request trace (`infra/README.md` "Tracing runbook").
- **CSP violation reports** (`POST /csp-report`) — a spike can be the
  first sign of an attempted XSS injection.
- **CloudFront / WAF logs** (when enabled) — edge-level request and
  rule-firing detail.
- **SES events** — bounce/complaint/delivery for email-related incidents.
- **Neon** — `status.neon.tech` for platform state; **a PITR branch is a
  frozen forensic copy** of the database at a chosen instant — create one
  *before* you start mutating data during containment.

**Preservation rule:** containment must not destroy the evidence a breach
assessment (or the CPDP) will need. Snapshot first, then clean up.

---

## 11. Drills and maintenance

A playbook that is never exercised is a hope, not a control.

- **Tabletop, twice a year (~30 min).** Pick a §5 scenario, walk it end
  to end on paper: which alarm, which runbook, where's the go-bag, what
  would I file with the CPDP? Fix whatever you couldn't answer.
- **The DR drill (Roadmap item 19)** is the *recovery half* of this
  playbook — run it quarterly once deployed (`ARCHITECTURE.md` §12.2),
  and treat the first one as a tabletop for §5.2.
- **Breach tabletop once a year** — run §6 against a hypothetical leaked
  credential: would I hit 72 hours? Is the CPDP contact still current? Is
  the register format still right?
- **After every real incident**, review whether this doc would have
  helped; update the scenario list, contacts, and templates from what you
  learned. The postmortem action items (§8) are the input.
- **Keep it current.** Re-check the CPDP contact details, the alarm list
  (against `infra/observability.tf` + `slo.tf`), and the Digital Omnibus
  status (§6.7) at the yearly review (`ARCHITECTURE.md` §11).

---

## 12. Appendices — copy-paste templates

Fill the bracketed fields. Keep completed breach/regulatory documents
**out of the public repo** (§2.1, §9).

### Appendix A — CPDP (Art. 33) notification

```
To:      Commission for Personal Data Protection (CPDP / КЗЛД)
Via:     kzld@cpdp.bg (qualified e-signature) | Secure Electronic Delivery System | post
Subject: Personal data breach notification — Best Online Shop Ever

1. Controller
   - Name / identifier: [legal entity, EIK]
   - Contact for more information: [name, email, phone]  (DPO if appointed)

2. Time
   - Became aware: [YYYY-MM-DD HH:MM Europe/Sofia]
   - This notification: [date/time]  (if > 72h, reason for delay: [...])
   - Notification type: [ ] initial   [ ] phased follow-up

3. Nature of the breach (Art. 33(3)(a))
   - What happened: [confidentiality / integrity / availability — describe]
   - Categories of data subjects: [customers / admin / ...], approx. number: [n]
   - Categories of records: [accounts / profiles / addresses / orders / ...],
     approx. number: [n]
   - Was the data encrypted/hashed/pseudonymised? [yes/no — which fields]

4. Likely consequences (Art. 33(3)(c)): [...]

5. Measures taken / proposed (Art. 33(3)(d)):
   - Containment: [...]
   - Eradication: [...]
   - Mitigation for affected individuals: [...]

6. Have data subjects been (or will they be) notified under Art. 34? [yes/no/why]
```

### Appendix B — Data-subject (Art. 34) notification (BG / EN)

> Send only for a **high-risk** breach (§6.6). Plain language. Bulgarian
> primary; English for non-Bulgarian-speaking customers if any.

```
Тема: Важно съобщение относно сигурността на Вашите лични данни

Уважаеми клиенти,

На [дата] установихме инцидент със сигурността, който засегна следните
Ваши лични данни: [категории данни]. Какво се случи: [ясно описание].
Възможни последствия: [...]. Какво направихме: [мерки]. Какво препоръчваме
да направите: [напр. сменете паролата си тук]. За въпроси: [контакт].

— Best Online Shop Ever
```

```
Subject: Important notice about the security of your personal data

We detected a security incident on [date] that affected the following of
your personal data: [categories]. What happened: [plain description].
Likely consequences: [...]. What we have done: [measures]. What we
recommend you do: [e.g. reset your password here]. Questions: [contact].

— Best Online Shop Ever
```

### Appendix C — Incident status update

```markdown
## Incident: [title]
**Severity:** SEV[1-4] · **Status:** Investigating | Identified | Monitoring | Resolved
**Impact:** [who/what is affected] · **Updated:** [YYYY-MM-DD HH:MM Sofia / UTC]

### Current status
[what we know now — no speculation]

### Actions taken
- [...]

### Next steps
- [... + ETA of next update]

### Timeline
| Time (Sofia / UTC) | Event |
|---|---|
| [HH:MM] | [event] |
```

### Appendix D — Blameless postmortem

```markdown
## Postmortem: [title]
**Date:** [date] · **Duration:** [Xh] · **Severity:** SEV[X] · **Author:** [name] · **Status:** Draft
**Personal-data breach?** [no / yes → register ref + CPDP ref]

### Summary
[2–3 plain-language sentences.]

### Impact
- Users affected: [...]
- Duration: [...]
- Business / compliance impact: [...]

### Timeline
| Time (Sofia / UTC) | Event |
|---|---|
| [HH:MM] | [detection → triage → containment → recovery] |

### Root cause
[What in the *system* allowed this.]

### 5 Whys
1. Why [symptom]? → [...]
2. Why? → [...]
3. Why? → [...]
4. Why? → [...]
5. Why? → [root cause]

### What went well
- [...]

### What went poorly
- [...]

### Action items
| Action | Owner | Priority | Due |
|---|---|---|---|
| [systemic fix] | [name] | P0/P1/P2 | [date] |

### Lessons learned
[Carry-forward; feed into the roadmap and the threat model.]
```

### Appendix E — Breach register row (Art. 33(5))

> Append-only. Out-of-band, not in the repo.

```
Breach ID:            [BR-YYYY-NN]
Detected (aware) at:  [YYYY-MM-DD HH:MM Europe/Sofia]
Type:                 [confidentiality / integrity / availability]
Description:          [what happened]
Data & subjects:      [categories + approx counts]
Risk assessment:      [unlikely to risk / risk / high risk]  — reasoning: [...]
CPDP notified?:       [no — why | yes: date/time + reference]
Data subjects (Art.34)?: [no — exception relied on | yes: date + method]
Containment/remedy:   [...]
Postmortem:           [link/path]
Closed:               [date]
```

---

*This is the incident-response umbrella doc. Procedures it dispatches to
live in `ARCHITECTURE.md` (§11 operations, §12 disaster recovery) and
`infra/README.md` (the per-feature runbooks). The standards it satisfies
are tracked in `COMPLIANCE.md` (NIST CSF 2.0 Respond/Recover, CIS 17,
GDPR Art. 33/34).*



