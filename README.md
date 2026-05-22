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
    ├── README.md         Functional / product specification (Bulgarian)
    ├── ARCHITECTURE.md   System design, operations, costs, A+ roadmap
    └── COMPLIANCE.md     2026 standards matrix (NIST CSF, OWASP, ASVS, SLSA, GDPR…)
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
schema's `email_verification_tokens.kind` enum carries `signup` (this
flow) and `email_change` (the email-change flow — see below) so the
same table serves both without a migration.

## Password reset

`/account/forgot-password` accepts an email and POSTs to
`POST /auth/forgot-password`, which issues a 32-byte CSPRNG token
(SHA-256 at rest, **1-hour validity** — the OWASP-recommended upper
bound) and sends a Bulgarian "set a new password" email. The endpoint
ALWAYS returns the same `{ ok: true }` regardless of whether the address
is registered, regardless of internal rate-limiting, regardless of email-
send failure — leaking any of those would defeat the
enumeration-resistance work in `/auth/register`.

The email links to `/account/reset-password?token=…`. The page fires
`POST /auth/reset-password/check` **on mount** to validate the token
without consuming it, so a dead/used link renders the "invalid link" UI
immediately — no form, no wasted password typing. Industry-standard UX
(GitHub, Google, Auth0, Stripe). The check endpoint returns the same
generic `400 /problems/invalid-reset-token` for unknown/expired/consumed.

Posting the token plus a new password to `POST /auth/reset-password`
atomically (a) marks the token consumed, (b) invalidates **every other**
outstanding reset token for the same user (defends against parallel-
token phishing), (c) rotates `password_hash`, and (d) drops every
active session for the user (per NIST SP 800-63B-4 and OWASP — an
attacker who initiated the reset is signed out alongside the legitimate
user). The reset endpoint is unauthenticated: the link IS the proof of
identity, just like `/verify-email`.

After a successful reset the API sends a **second** Bulgarian email,
`auth.password-changed`, telling the recipient when the change happened
and what to do if they did NOT request it (lock down email, contact
support). 2026 best practice — gives the victim of a phished mailbox a
real-time alert.

Rate limiting on the forgot endpoint: per-EMAIL caps (3/hour, 5/day)
evaluated BEFORE issuing a token. A rate-limited request still returns
the same generic 200 — surfacing 429 here would itself leak that the
email is registered. Per-IP volume defence stays at WAF (matches the
lockout slice's stance).

**Multi-device session drop:** the reset deletes every `sessions` row
for the user server-side, but a cookie sitting in another browser
isn't reachable that way (cookies live in the browser; only Set-Cookie
response headers can clear them). The `currentUser` middleware closes
the loop: whenever a request arrives with a cookie that no longer
matches any session row, the response carries a `Set-Cookie: Max-Age=0`
header that wipes the orphaned cookie. One round-trip on the other
browser is enough — without this, the thin proxy keeps treating the
dead cookie as "logged in" and bounces `/account/login` back to
`/account/profile` in a UX loop.

In **local dev**, `console`-transport prints both emails to `api:dev`'s
stdout. Smoke flow: register → log in → /account/forgot-password →
copy the reset URL from the API terminal → submit a new password →
land on /account/login with a green "Паролата Ви беше променена
успешно" banner → log in with the new password.

**Cross-device behaviour you can demo locally:** open two browsers
logged in as the same user; reset from one; navigate anywhere on the
second; AuthContext fetches /auth/me which clears the stale cookie via
Set-Cookie; the second browser is now signed out cleanly and can log
in with the new password.

## Email change

`/account/email-change` accepts a new email plus the user's CURRENT
password as re-auth proof, and POSTs to `POST /auth/email-change/request`.
The endpoint is authenticated AND requires the current password — a
stolen cookie alone is NOT enough to pivot to a permanent account
takeover. This is OWASP's "MFA may be appropriate for sensitive
actions" advice; we don't yet have MFA so password re-auth is the
strongest local equivalent.

On request the backend issues a 32-byte CSPRNG token (SHA-256 at rest,
**1-hour validity**) into the existing `email_verification_tokens`
table with `kind = 'email_change'` and the proposed new address on
`new_email`. `users.email` is NOT updated yet — the change is gated on
the click. Two emails are sent best-effort, in parallel:

- **Verify link to the NEW address** (`auth.email-change-verify`).
  Only the holder of the proposed new mailbox can complete the change.
  The link lands on `/account/email-change/verify?token=…`.
- **Alert to the OLD address** (`auth.email-change-alert`). Plainly
  shows the proposed new address. No actionable link — doing nothing
  IS the revert. This is OWASP's "out-of-band notification of a
  sensitive change" defence: if the request was unauthorised, the
  legitimate owner gets a real-time heads-up via the channel they
  still control.

The request endpoint is **enumeration-resistant by contract**:
identical 200 for the happy path, for the "new address already in use
by another active user" case (silent — we never send a verify mail to
an existing user's address), and for internally-rate-limited cases
(3/hour, 5/day per user). The two non-resistant 4xx branches are
explicit user errors: 401 for a wrong current password (the user can
see they typed wrong), and 400 for "new == current" (the authenticated
user can already see their own email; nothing to enumerate).

The verify page fires `POST /auth/email-change/verify/check` **on
mount** — same validate-on-mount pattern as the reset page. On a live
token it returns the destination email so the page can render "you are
confirming change to X". On dead it returns the generic
`400 /problems/invalid-email-change-token` — the page locks into
"invalid/expired" UI on first paint. The verify is **not** auto-fired:
email-client scanners (Microsoft Defender for Office 365, antivirus,
link-checkers) sometimes prefetch the first link they parse, which
would burn the token before the user even sees the page. The explicit
"Потвърди смяната" button means scanners see HTML but never POST.

Posting the token to `POST /auth/email-change/verify` atomically:

1. Marks this token consumed.
2. Marks **every other** outstanding email-change token for the user
   consumed (parallel-token phishing defence, same as password-reset).
3. Rotates `users.email` to the new address.
4. Sets `users.email_verified_at = now()` — the click IS the proof
   that the new mailbox is controlled by the user.
5. Drops EVERY session for the user (per NIST + OWASP).
6. Best-effort sends `auth.email-changed` to the OLD address.

A late-conflict check guards against the destination being claimed by
a different user between request and verify (race window). If the new
address has been taken in the meantime, the verify returns the same
generic 400 and the original `users.email` is unchanged.

The verify endpoint is unauthenticated — the token IS the proof of
control of the new mailbox, just like the reset and signup-verify
endpoints. Same posture, same threat model.

After success the user must re-log-in with the new address. The verify
page calls `useAuth().logout()` first (to wipe the orphaned local
cookie) and redirects to `/account/login?email-changed=success` so the
login page renders a green confirmation banner.

Rate limiting on the request endpoint: per-USER caps (3/hour, 5/day)
evaluated BEFORE issuing a token. A rate-limited request still returns
the same generic 200 (consistent with the forgot-password contract).

In **local dev**, `console`-transport prints all three emails (verify,
alert, post-change notification) to `api:dev`'s stdout. Smoke flow:
log in → /account/email-change → enter new address + current password
→ copy verify URL from the API terminal → click it → "Потвърди
смяната" → land on /account/login with the green banner → log in with
the new address.

## Password change (authenticated)

`/account/profile` exposes a password-change form alongside the
personal-data section. Submitting POSTs to `POST /auth/change-password`
with the user's **current** password plus a new one. The endpoint:

1. **Requires an active session** (the unauthenticated counterpart is
   `/auth/reset-password` via emailed token).
2. **HIBP-screens the new password first** (same k-anonymity check as
   register / reset; fail-open on HIBP outage). Burning a verify
   attempt against the shared-with-`/login` lockout because the user
   picked a breached new password would punish the wrong thing.
3. **Rejects newPassword === currentPassword** with a distinct
   `type: "/problems/same-password"` problem URI so the UI can render
   a localized "your new password must differ" inline against the
   newPassword input.
4. **Pre-checks the per-email lockout** before doing the
   currentPassword verify. The lockout counter is the same one
   `/auth/login` uses, so an attacker with a stolen session cookie
   cannot brute-force the password through this endpoint without
   tripping the same 5-fails-in-15-min ceiling. The 429 carries
   `type: "/problems/account-locked"` — identical to login lockout.
5. **Constant-time verifies the current password** against the stored
   Argon2id hash (uses `DUMMY_PASSWORD_HASH` if the row went missing
   between session validation and now, to keep timing flat). Records
   the attempt to `login_attempts` whether the row exists or not.
6. **On success:** rotates `users.password_hash`, then calls
   `deleteAllSessionsForUser(userId, session.idHash)` — every OTHER
   session for the user dies; the device that initiated the change
   keeps its cookie. Industry convention: the caller just proved
   current-password knowledge, so logging them out would be churn.
7. **Best-effort sends `auth.password-changed`** to the account
   address. Same template the reset-password flow uses. Failure to
   send must NOT roll back the rotation — the user already typed a
   new password successfully.

This closes **OWASP ASVS V6.2** ("verifier MUST allow the subscriber
to change their memorized secret") and **NIST SP 800-63B Rev. 4
§5.1.1.2** ("subscribers SHALL be able to change their memorized
secret"). The OWASP Authentication Cheat Sheet "Change Password
Feature" requirements (active session + current password + HIBP
screen) are all met.

In **local dev**, `console`-transport prints the post-change
notification to `api:dev`'s stdout. Smoke flow: log in → /account/
profile → fill "Текуща парола" + "Нова парола" (≥12 chars) +
"Потвърди" → submit → see the green "Паролата е сменена успешно"
banner → confirm the post-change notification email landed in the
API terminal. Cross-device demo: log in on two different browsers
simultaneously, change password from browser A, confirm browser B
gets bounced to /account/login on its next request (its session
was dropped) while browser A stays logged in.

## Order withdrawal (14-day right)

`/account/orders/[orderNumber]/withdrawal` is the **digital withdrawal
function** required by EU Directive 2023/2673 amending Article 11a of
the Consumer Rights Directive 2011/83/EU — mandatory in every EU member
state from **19 June 2026**. The legal requirement is concrete: every
e-commerce site that contracts with EU consumers must (i) offer a
clearly labelled withdrawal button, (ii) keep it findable and
continuously available throughout the 14-day window, (iii) let the
consumer identify the contract being withdrawn from, (iv) accept a
clear withdrawal statement, and (v) issue an acknowledgement of receipt
on a durable medium with the **exact date and time of submission**.
Non-compliance extends the consumer's withdrawal period to **12 months
and 14 days**.

The slice ships three new routes on the existing `/orders/*` mount:

- **`GET /orders/:n/withdrawal/eligibility`** — read-only. Returns
  `eligible: true { acceptedAt, deadlineAt, alreadySubmittedAt }` or
  `eligible: false { reason: "not_accepted" | "window_expired" }`. The
  frontend uses this on the order detail page to decide whether to
  render the button at all. 404 for "order not yours / does not exist"
  (enumeration-resistant, same posture as the rest of `/orders/*`).
- **`GET /orders/:n/withdrawal`** — auth-gated. Returns the persisted
  record, or 404 if none. Powers the receipt re-read view.
- **`POST /orders/:n/withdrawal`** — body `{ reason?: string }`, where
  `reason` is optional (Art. 9(1) of the Directive: "without giving any
  reason"). Idempotent at the DB level via a partial unique index on
  `complaints.order_id WHERE reason = 'withdrawal'`: a second
  submission for the same order returns 200 with the original record.
  No `Idempotency-Key` header required — the partial unique index IS
  the idempotency boundary. RFC 9457 types:
  `/problems/withdrawal-not-accepted` (422),
  `/problems/withdrawal-window-expired` (422).

Storage: the existing `complaints` table picks up four columns —
`customer_email`, `customer_name`, `customer_phone`,
`acknowledged_at`. The first three are denormalised from the order at
submission time so the audit trail survives later profile edits and
the receipt email can be reconstructed from the row alone (durable
medium); `acknowledged_at` is set when the customer-acknowledgement
email send succeeds. A new partial unique index
`complaints_order_withdrawal_unique` enforces one withdrawal per order
at the DB level. Migration: `0002_complaints_withdrawal.sql`.

The order DTO grows a new `acceptedAt: string | null` field — the
frontend uses it to know whether to fetch eligibility at all (most
orders never reach `accepted`, so we skip the round trip).

Two new emails (templates 7 and 8 in `@shop/email`, total now EIGHT):

- **`orders.withdrawal-received`** to the customer. Subject "Получихме
  отказа Ви от поръчка {orderNumber}". Renders the submission
  timestamp explicitly in Sofia local time at second precision,
  satisfying Art. 11a(2)'s "exact date and time" obligation. Mentions
  the legal basis (чл. 50 ЗЗП). No upsell, no nag, no countdown — per
  recital 37, the email must not contain dark patterns.
- **`orders.withdrawal-admin-notification`** to the support inbox
  (derived from `EMAIL_FROM`). Operations-focused: order number,
  customer contact, reason. The README §7 design intent is preserved:
  "the platform RECORDS complaints — actual handling happens via
  email/phone outside the app."

Both emails are best-effort `Promise.allSettled` in parallel; failure
of either does not change the API response. Re-submissions skip the
emails entirely (the record is unchanged; re-notifying the admin would
just be noise).

The frontend surface:

- **Order detail page** (`/account/orders/[orderNumber]`) renders the
  "Откажете се от договора тук" card *only* when status is `accepted`
  AND eligibility comes back `eligible: true`. The exact wording is
  the Art. 11a(1)(a) "clearly labelled" requirement transposed to
  Bulgarian. If `alreadySubmittedAt` is set, the card shows "Прегледай
  отказа" instead.
- **Withdrawal page** (`/account/orders/[orderNumber]/withdrawal`)
  carries the order summary, an optional reason textarea (explicitly
  labelled "по избор" — by choice — with a clarifying note that no
  reason is required by law), a single CTA "Откажете се от договора",
  and on success a durable-medium receipt view with the exact
  submission timestamp.
- **`/terms/withdrawal`** is a server component carrying the full
  Bulgarian text of the withdrawal policy + Annex I(B) model
  withdrawal form (Приложение № 6 към чл. 47 от ЗЗП). Linked from the
  footer, `/terms`, `/delivery`, the order detail card, and the
  withdrawal page header.

The withdrawal request endpoint is auth-gated (no guest flow in this
slice — that needs the guest-tracking-token surface which doesn't
exist yet; deferred). The eligibility window is computed off
`orders.accepted_at`, which is populated by the admin "mark accepted"
transition. Today that transition is admin-only and admin-api isn't
built yet, so dev testing requires manually flipping a row to
`status='accepted', accepted_at=now()` via psql.

In **local dev**, `console`-transport prints both emails to `api:dev`'s
stdout. Smoke flow: register / verify / log in → place an order via
the regular cart flow → in another terminal,
`UPDATE orders SET status='accepted', accepted_at=now() WHERE
order_number=…;` → reload the order detail page → the withdrawal card
appears → click "Откажете се от договора тук" → submit → on-screen
receipt with the timestamp, plus the customer email + admin
notification visible in `api:dev`.

## Documentation

Read the docs in this order:

1. `docs/README.md` — what the shop does (product spec, in Bulgarian)
2. `docs/ARCHITECTURE.md` — how it's built and run, plus the roadmap to A+ across every 2026 standard
3. `docs/COMPLIANCE.md` — auditor-facing standards-by-standards matrix (NIST CSF 2.0, OWASP Top 10 2025, OWASP ASVS 6.0, NIST SP 800-63B-4, SLSA, CIS Controls v8.1, GDPR, EU CRA, WCAG 2.2)

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
- **Password policy follows NIST SP 800-63B Rev. 4** (finalised mid-2025).
  `PasswordSchema` enforces ≥12 chars, ≤1024 chars, **no composition rules**
  (no "must contain upper/lower/digit"). Strength comes from length +
  HIBP screening, not from forced character classes.
- **Breached-password screening** at registration and password-reset via the
  HIBP Pwned Passwords k-anonymity API
  (`backend/auth/src/breached-password.ts`). SHA-1 the password locally,
  transmit only the 5-char prefix, scan returned suffixes for a count ≥ 1.
  `Add-Padding: true` header per HIBP v3 spec. Login is intentionally NOT
  gated by this — would lock out existing customers whose historically-
  acceptable passwords later turn up in a breach. **Fail-open** semantics:
  if HIBP is unreachable, the request is allowed with a structured
  `breached_password_check_unavailable` warning log; we don't couple our
  signup availability to a single-vendor free service.
  `BREACHED_PASSWORD_CHECK_ENABLED` env var (default `true`) is the
  incident kill-switch; vitest config defaults it to `false` so the suite
  stays off the public endpoint, with one dedicated test that re-enables it
  with a stubbed `globalThis.fetch`.
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
- **Orphaned-cookie cleanup**: `currentUser` calls `clearSessionCookie(c)`
  whenever the cookie is present but `validateSession` returns null
  (session expired / user deleted / session row dropped by a password
  reset on another device). The response carries `Set-Cookie:
  …; Max-Age=0` which wipes the stale cookie on the caller's browser.
  Without this, the thin proxy's cookie-presence check would keep
  treating Browser B as authenticated indefinitely, redirecting
  `/account/login` → `/account/profile` → 401 → `/login` in a loop the
  user can't escape from. A DB hiccup branch deliberately does NOT
  clear the cookie — the session may still be perfectly valid; we just
  couldn't reach the DB to confirm.
- **CORS with credentials** explicitly enabled. Frontend uses
  `credentials: "include"` on every `/auth/*`, `/cart/*`, `/orders/*` fetch;
  API echoes the origin from an allowlist (no wildcard, which is incompatible
  with credentials). `allowHeaders` includes `Idempotency-Key` — a non-simple
  request header forces an `OPTIONS` preflight, and the server has to
  advertise the header explicitly or the browser blocks the actual `POST`.
- **Next.js 16 thin proxy** (`frontend/src/proxy.ts`, formerly `middleware.ts`):
  cookie-presence check only, never validates the token. Real auth happens
  in pages and Server Components. `PUBLIC_ACCOUNT_PATHS` enumerates the
  account-prefixed routes anonymous visitors are allowed to reach:
  `/login`, `/register`, `/forgot-password`, `/reset-password`,
  `/verify-email`, `/email-change/verify`. All four recovery routes
  MUST be public — the email link IS the proof of identity (of the
  mailbox, in the email-change case), and the user may legitimately
  click it from any device, including one that has never logged in.
  Token validation stays at the API layer; the proxy just gets out of
  the way.
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
- **Password-reset token cryptography** mirrors verification: 32-byte
  CSPRNG → base64url, SHA-256 hashed in `password_reset_tokens.token_hash`,
  single-use, **1-hour validity** (per OWASP — tighter than the 24h
  verification token because the attack value is higher). Bad / expired /
  already-consumed tokens return the SAME generic
  `400 /problems/invalid-reset-token`.
- **`POST /auth/forgot-password` is enumeration-resistant by contract**:
  the response body is identical for known emails, unknown emails,
  internally-rate-limited emails, and SES-failure emails. Surfacing a
  429 (or any 4xx/5xx beyond input-validation) on the forgot endpoint
  would itself leak which addresses are registered. The hourly/daily
  caps are evaluated INSIDE the handler before issuing a token, but the
  decision is invisible to the caller.
- **`POST /auth/reset-password` invalidates ALL outstanding reset tokens
  for the user**, not just the one being consumed. An attacker who
  phished token #1 must lose access the moment the user resets via
  token #2 — single-token consumption alone doesn't cover that
  attack class.
- **`POST /auth/reset-password` drops every session for the user** (NIST
  SP 800-63B-4 + OWASP defence-in-depth). The reset page intentionally
  redirects to `/account/login?reset=success` rather than auto-logging
  in: rewarding the page that just rotated the password with a fresh
  session would benefit an attacker who clicked the link in a phished
  inbox just as much as the legitimate user.
- **Post-reset notification email** (`auth.password-changed`) sent on
  every successful reset. Best-effort like the reset email itself —
  failure to notify must NOT roll back the rotation. The notice carries
  the timestamp + what to do if you didn't initiate the change.
- **Validate-on-mount reset UX**: `/account/reset-password` POSTs to
  `/auth/reset-password/check` on mount to discover dead links before
  the user types anything. The check endpoint is pure-read: it does
  NOT consume the token (consuming-as-probe doesn't work anyway —
  Zod password-strength validation runs before token lookup, so the
  consume endpoint can't be used as an oracle without rotating the
  password). The endpoint is not meaningfully an attack surface either:
  tokens are 256-bit random, so an attacker who could probe them still
  couldn't enumerate the search space. Same generic
  `400 /problems/invalid-reset-token` for any failure case.
- **Reset page calls `logout()` before redirecting on success**: the
  API drops every session for the user, but the cookie still sits in
  THIS browser. Without a local logout, the redirect to
  `/account/login?reset=success` would be bounced by the proxy
  ("cookie present → logged in → /profile") and the user would loop.
  `/auth/logout` is idempotent so this is also safe when the device
  wasn't actually logged in.
- **Email-change token cryptography** mirrors password-reset and
  verification: 32-byte CSPRNG → base64url, SHA-256 hashed in
  `email_verification_tokens.token_hash`, single-use, **1-hour
  validity** (per OWASP — same threat tier as password reset). The
  proposed-new address rides on the existing `new_email` column;
  `users.email` is NOT mutated until the verify link is clicked, per
  the OWASP "store the proposed-new email as a proposed-new value"
  guidance. Bad / expired / already-consumed / now-conflicting tokens
  all return the SAME generic
  `400 /problems/invalid-email-change-token`.
- **`POST /auth/email-change/request` requires current-password
  re-auth.** OWASP "Changing A User's Registered Email Address"
  explicitly recommends MFA for this action; we don't yet have MFA so
  password re-auth is the strongest local equivalent. A stolen session
  cookie alone must NOT be enough to permanently pivot the account.
  Wrong-password returns the same 401 shape as `/auth/login` — no
  enumeration of "session valid but password wrong".
- **Out-of-band notification to the OLD address at REQUEST time**
  (`auth.email-change-alert`) plus a second notification at
  CONFIRM time (`auth.email-changed`). OWASP's defence-in-depth
  pattern: notify the channel the legitimate owner still controls so
  unauthorised changes surface immediately, AND leave a final audit
  trail after the rotation. The alert deliberately contains NO
  actionable link — doing nothing IS the revert; clicking a link in an
  alert email is just another phishing vector for the same attacker.
- **`POST /auth/email-change/request` is enumeration-resistant by
  contract**: identical 200 for happy path, conflict (new address
  already in use), and internally-rate-limited (3/hr, 5/day per
  user). Surfacing a 409 here would let an authenticated attacker
  probe email registration via this endpoint as readily as via
  `/auth/login`'s timing channel.
- **`POST /auth/email-change/verify` invalidates ALL outstanding
  email-change tokens for the user**, not just the one being consumed.
  Same parallel-token phishing defence as the password-reset slice —
  an attacker holding a second valid token must lose access the moment
  the legitimate user confirms via theirs.
- **`POST /auth/email-change/verify` drops every session for the
  user** (NIST SP 800-63B-4 + OWASP). The verify page redirects to
  `/account/login?email-changed=success` rather than auto-logging in:
  same threat-model argument as the reset slice.
- **Late-conflict check on verify**: the destination address might be
  registered by someone else between request and verify (race
  window). The consume re-checks that the new address is still
  available — if not, the token is treated as dead and the original
  `users.email` is unchanged. Returned to the caller as the same
  generic 400.
- **Validate-on-mount verify UX**: `/account/email-change/verify`
  POSTs to `/auth/email-change/verify/check` on mount to discover
  dead links before the user clicks. The check endpoint surfaces the
  destination address on a live token so the page can render "you are
  about to confirm change to X" — value-neutral disclosure since the
  recipient already received this link at that address. **Verify is
  not auto-fired on mount**: email-client scanners (Microsoft
  Defender for Office 365, antivirus, link-checkers) sometimes
  prefetch the first link in a message; an auto-consume would let
  them burn the token before the user sees the page. The explicit
  "Потвърди смяната" button means scanners see HTML but never POST.
- **Verify page calls `logout()` before redirecting on success**: the
  API drops every session, but the cookie still sits in THIS browser.
  Without a local logout the redirect to login would be bounced by
  the proxy in the same loop the password-reset slice documents.
- **Proxy `PUBLIC_ACCOUNT_PATHS` includes
  `/account/email-change/verify`**: the email link is delivered to
  the NEW address and may be opened on a device that has never
  logged in to the shop. Gating it behind a session would defeat the
  recovery purpose.

### Order withdrawal slice — decisions baked in

- **Legal driver**: Article 11a of Directive 2011/83/EU as amended by
  Directive 2023/2673 — mandatory for every EU e-commerce site
  contracting with consumers from **19 June 2026**. The mandate is
  specifically a *digital* withdrawal mechanism (the "withdrawal
  button"), distinct from the long-standing right itself which already
  existed via the original 2011 Directive. The implementation also
  satisfies чл. 50 от ЗЗП (Bulgarian Consumer Protection Act).
- **Single source of truth for the window**: `orders.accepted_at` is
  the canonical timestamp. The 14-day window runs from that instant.
  The order_status_history table is NOT consulted for eligibility —
  the column is the contract. If `status='accepted' AND accepted_at IS
  NULL` (broken invariant) the order is treated as ineligible.
- **Authoritative legal label**: the primary CTA on both the order
  detail card and the withdrawal page reads "Откажете се от договора
  тук" — the Bulgarian rendering of the unambiguous wording Art.
  11a(1)(a) requires. No marketing-softening allowed.
- **No `Idempotency-Key` header**: the partial unique index
  `complaints_order_withdrawal_unique` (on `complaints.order_id WHERE
  reason = 'withdrawal'`) makes the operation idempotent at the DB
  level. A second submission for the same order returns 200 with the
  original record verbatim. We deliberately do NOT require an
  Idempotency-Key header here (unlike `POST /orders`) because the
  operation has a different idempotency boundary — the order itself,
  not the request.
- **Customer snapshot is denormalised** onto the complaints row at
  submit time (`customer_email`, `customer_name`, `customer_phone`).
  The order already carries the same snapshot from placement; copying
  again to the complaint row means the audit trail stands alone even
  if the order is anonymised under a future GDPR retention sweep.
- **Reason is OPTIONAL**: stored on `complaints.description`. Art.
  9(1) of the Directive: the consumer is NOT required to justify the
  withdrawal. The UI labels the field "Причина (по избор)" with a
  clarifying note. We capture if offered (helps support); we never
  require.
- **Durable medium = on-screen + email**: the on-screen receipt
  rendered immediately after submission IS the primary durable medium
  per recital 37 (a "durable medium" is anything the consumer can
  store, reproduce unchanged, and access for an adequate period; the
  receipt page meets that). The email is defence in depth. Both render
  the timestamp in Europe/Sofia at second precision so they agree.
  `acknowledged_at` is set when the email send succeeds; null on
  failure means the audit trail is still complete (just missing the
  email-delivery proof).
- **Best-effort email send**: both customer ack and admin
  notification go out via `Promise.allSettled` in parallel. Failure of
  either does not change the API response (200/201 with the record).
- **Re-submissions do NOT re-send emails**: the second POST returns
  the existing record but skips the email step. Re-emailing would be
  pure noise; the customer already has their receipt.
- **`/orders/:n/withdrawal/eligibility` returns 200 for ineligible-
  but-existing orders**: structured `{ eligible: false, reason }`
  body. 404 is reserved for orders the user doesn't own (the existing
  `/orders/*` enumeration-resistant contract).
- **POST is auth-gated** (`requireAuth`). No guest-flow in this slice
  — that needs the guest-tracking-token surface (`/track/:token`),
  which is itself a deferred slice. The schema does NOT carry any
  guest-vs-auth assumption; when the guest surface lands it can write
  to the same `complaints` table.
- **422 type taxonomy**:
  `/problems/withdrawal-not-accepted` for orders not yet in
  `accepted` status, `/problems/withdrawal-window-expired` for orders
  past the 14-day cutoff. Distinct types because the customer-facing
  remedy differs: the former is "wait", the latter is "contact us".
- **Order DTO grows `acceptedAt`**: the FE uses it to decide whether
  to even ask for eligibility. Most orders are pre-accepted and would
  always return `not_accepted`; gating on `acceptedAt != null` skips
  ~95% of pointless requests on the order detail page.
- **`/terms/withdrawal` is a server component**: pure markup, no JS
  required. Art. 6(1)(h) requires the disclosure to be clear and
  comprehensible BEFORE the consumer is bound — a JS-dependent
  disclosure is harder to defend if a regulator visits with text-mode
  curl. Linked from the footer (under "Помощ"), the omnibus `/terms`
  page, the `/delivery` "Returns" section, the order detail card, and
  the withdrawal page header — four entry points so the disclosure is
  "easy to find" per Art. 11a(1)(b).
- **No dark patterns** (recital 37, Art. 16d): no "are you sure?"
  double confirmation, no countdown timer pressuring the user, no
  upsell interstitial, no "would you like to keep the goods at half
  price?" deflection. The button label is the unambiguous legal
  wording; the optional-reason copy explicitly tells the user a reason
  is NOT required by law. The post-submit page is celebratory only
  insofar as it confirms receipt — no negative-emotion copy ("we're
  sorry to see you go" etc.) which Art. 16d's prohibition against
  manipulative interfaces would flag.
- **Schema is generic, app layer enforces invariants**: the four new
  columns on `complaints` are nullable at the column level (so the
  table stays usable for the other complaint kinds — `defective`,
  `wrong_item`, `other` — which don't have the same Art. 11a
  evidentiary requirements). The app layer enforces NOT NULL for
  `reason='withdrawal'` at INSERT time.

## Status

### Backend

- **`@shop/db`** — schema feature-complete for catalog, auth, cart, and orders.
  30 tables, 32 FKs, 44 indexes, 10 enums. Idempotent seed.
  `email_verification_tokens` and `password_reset_tokens` were already in
  the schema with `kind` (`signup` / `email_change`), `consumed_at`,
  `expires_at` — the verification slice consumed them without a migration.
  The withdrawal slice (migration `0002_complaints_withdrawal.sql`) added
  four columns to `complaints` (`customer_email/name/phone`,
  `acknowledged_at`) plus a partial unique index
  `complaints_order_withdrawal_unique`.
- **`@shop/auth`** — Argon2id helpers, session token generation/hashing,
  `DUMMY_PASSWORD_HASH`, and HIBP k-anonymity breached-password screening
  (`checkPasswordBreached`). Zero runtime dependencies beyond `argon2`
  (HIBP uses native `fetch` from Node 22+ — see
  `backend/auth/src/breached-password.ts`). 30+ unit tests covering
  password hashing, session tokens, and HIBP (happy path, request shape,
  every fail-open branch).
- **`@shop/email`** — transactional email. Three transports
  (`createSesTransport`, `createConsoleTransport`, `createStubTransport`)
  behind a common `EmailTransport` interface, plus eight Bulgarian
  templates:
  - `renderVerificationEmail` (signup)
  - `renderPasswordResetEmail` (forgot-password link)
  - `renderPasswordChangedEmail` (post-reset security notice)
  - `renderEmailChangeVerifyEmail` (email-change verify link, sent to
    NEW address)
  - `renderEmailChangeAlertEmail` (out-of-band alert at request time,
    sent to OLD address with the proposed new value)
  - `renderEmailChangedEmail` (post-change notice, sent to OLD address
    with the new value)
  - `renderWithdrawalReceivedEmail` (14-day withdrawal acknowledgement
    to the customer; Art. 11a(2) durable medium with Sofia-timezone
    timestamp at second precision)
  - `renderWithdrawalAdminNotificationEmail` (operations notice to the
    support inbox at withdrawal-submission time)

  All inline-styled HTML + plain-text fallback. `@aws-sdk/client-sesv2`
  is the only runtime dep — no Nodemailer, no full SDK. Unit tests
  cover every template's rendering (including HTML-escape coverage of
  injection-prone fields like the new email address), the SES
  `SendEmailCommand` shape (with a mocked client — never hits AWS),
  and the stub transport's recorder API.
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
  - `/auth/forgot-password`, `/auth/reset-password/check`,
    `/auth/reset-password` — password-recovery flow. Same crypto shape
    as verification; **1h validity** per OWASP.
    `forgot-password` is unauthenticated and ALWAYS returns the same
    `{ ok: true }` (enumeration-resistant); known emails get a Bulgarian
    reset link, unknown emails get nothing, internally-rate-limited
    emails (3/hr, 5/day per user) silently get nothing.
    `reset-password/check` is the read-only "is this link still good?"
    probe the reset page fires on mount — returns 200 `{ valid: true }`
    for live tokens, 400 `/problems/invalid-reset-token` for any failure
    state. Does NOT consume the token.
    `reset-password` is unauthenticated (token IS the proof), accepts a
    token + new password, atomically rotates `password_hash`,
    invalidates EVERY other outstanding reset token for the user, and
    drops EVERY session for the user. Bad / expired / already-consumed
    tokens return the SAME generic `400 /problems/invalid-reset-token`.
    After a successful reset, sends a Bulgarian "your password was
    changed" notification (`auth.password-changed` template) —
    best-effort, doesn't roll back on send failure.
  - `/auth/change-password` — authenticated self-service password
    rotation, gated by `requireAuth`. Requires `currentPassword` as
    re-auth proof (defeats the walked-away-from-shared-computer
    threat per OWASP Authentication Cheat Sheet "Change Password
    Feature"). Order of checks: (1) HIBP screens `newPassword`
    before anything else (fail-open on HIBP outage; consistent with
    register / reset); (2) reject newPassword === currentPassword
    with `400 /problems/same-password`; (3) per-email lockout
    pre-check (shares the counter with `/auth/login` — a stolen
    cookie attacker hits the same 5-fails-in-15-min ceiling);
    (4) constant-time verify against the stored Argon2id hash with
    `DUMMY_PASSWORD_HASH` fallback to keep timing flat; (5) on
    success, rotate `password_hash` and `deleteAllSessionsForUser
    (userId, session.idHash)` — every OTHER device signs out, THIS
    session is preserved. After rotation, sends `auth.password-
    changed` to the account address (best-effort, same template
    `/auth/reset-password` uses). Closes OWASP ASVS V6.2 / NIST SP
    800-63B-4 §5.1.1.2.
  - `/auth/email-change/request`, `/auth/email-change/verify/check`,
    `/auth/email-change/verify` — email-change flow. Same crypto shape
    as verification (32-byte CSPRNG, SHA-256 at rest, 1h validity,
    single-use). Tokens live on the existing
    `email_verification_tokens` table with `kind = 'email_change'` and
    the proposed new address on `new_email`. `users.email` is NOT
    rotated until the link is clicked.
    `email-change/request` requires a session AND the current password
    as re-auth proof (a stolen cookie is not enough to take over the
    account permanently). Same generic 200 for happy / conflict
    (new email already in use by another user) / rate-limited
    (3/hr 5/day per user) — fully enumeration-resistant. 401 for a
    wrong current password, 400 for "new == current" (no enumeration
    possible — the user can see their own email).
    `email-change/verify/check` is the read-only "is this link still
    good?" probe the verify page fires on mount — returns 200
    `{ valid: true, newEmail }` for live tokens, 400
    `/problems/invalid-email-change-token` for any failure state. Does
    NOT consume the token.
    `email-change/verify` is unauthenticated (token IS the proof of
    new-mailbox control), atomically rotates `users.email`, sets
    `email_verified_at = now()`, invalidates EVERY other outstanding
    email-change token for the user, and drops EVERY session for the
    user. Late-conflict check guards against the destination being
    claimed in the race window. Bad / expired / consumed / conflicting
    tokens return the SAME generic
    `400 /problems/invalid-email-change-token`. After a successful
    rotation, sends a Bulgarian "your email was changed"
    (`auth.email-changed`) notification to the OLD address —
    best-effort.
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
    snapshot `order_corporate_data`; email-verified gate; `acceptedAt`
    surfaced on the DTO for the FE withdrawal-button eligibility check)
  - `/orders/:orderNumber/withdrawal`,
    `/orders/:orderNumber/withdrawal/eligibility` (auth-gated; 14-day
    right-of-withdrawal flow per EU Directive 2023/2673 Art. 11a — see
    "Order withdrawal" section above; idempotent at the DB level via a
    partial unique index on `complaints`; emails best-effort customer
    acknowledgement + admin notification in parallel; 422 types
    `/problems/withdrawal-not-accepted` and
    `/problems/withdrawal-window-expired`)
  - `/health`, `/openapi.json`
  - 140+ integration tests (catalog, categories, auth, cart, orders,
    verification, password reset, email change, and withdrawal slices)
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
- **Password reset UI** wired end-to-end:
  - `lib/auth/client.ts` — added `forgotPassword(email)`,
    `validateResetToken(token)`, and `resetPassword(token, newPassword)`.
    New `invalid_reset_token` variant on the `AuthError`
    discriminated union.
  - `app/(shop)/account/forgot-password/page.tsx` — single email input.
    Always shows the SAME "if this email exists, you'll receive a link"
    success copy on any non-validation/non-network outcome — mirrors the
    backend's enumeration-resistant contract.
  - `app/(shop)/account/reset-password/page.tsx` — handles the
    `?token=…` link click. Mount lifecycle: `checking` (validates the
    token via `/auth/reset-password/check`) → `live` (shows form) or
    `dead` (shows "invalid/expired" UI with a "Поискай нов линк"
    button). React 19 strict-mode double-invoke guarded with a useRef.
    New + confirm password inputs (confirm is client-only — the API has
    no notion of confirm). Server-side validation rules are the source
    of truth for password strength — the page surfaces the field error
    inline. On success: calls `logout()` first to wipe a possibly-stale
    local cookie (otherwise the proxy would bounce us off `/login`),
    then redirects to `/account/login?reset=success` so the login page
    renders a green "Паролата Ви беше променена успешно" banner.
    Auto-login on success is intentionally NOT implemented — it would
    benefit an attacker who clicked the link in a phished mailbox just
    as much as the user.
  - `proxy.ts` `PUBLIC_ACCOUNT_PATHS` — added `/account/reset-password`
    AND (latent bug from the verification slice) `/account/verify-email`
    to the anonymous-allowed list. Both recovery flows must work
    without a session; the email link IS the proof of identity.
  - The login page already linked to `/account/forgot-password`; that
    link is now wired to a real handler.
- **Email change UI** wired end-to-end:
  - `lib/auth/client.ts` — added `requestEmailChange({ currentPassword,
    newEmail })`, `validateEmailChangeToken(token)`, and
    `confirmEmailChange(token)`. New `invalid_email_change_token`
    variant on the `AuthError` discriminated union.
  - `app/(shop)/account/email-change/page.tsx` — authenticated request
    form. Asks for the new email plus the current password (re-auth).
    Client-side identity check catches "new == current" before a
    round-trip; the backend has the canonical rule. On submit success
    shows the same Bulgarian "Проверете новата си поща" copy on any
    non-validation/non-credentials/non-network outcome — mirrors the
    backend's enumeration-resistant contract.
  - `app/(shop)/account/email-change/verify/page.tsx` — public, handles
    the `?token=…` link click delivered to the new address. Mount
    lifecycle: `checking` (validates the token via
    `/auth/email-change/verify/check`) → `live` (shows a one-click
    confirm screen with the destination address) or `dead` (shows
    "invalid/expired" UI with a "Нова заявка" button). React 19
    strict-mode double-invoke guarded with a useRef. The confirm
    button POSTs `/auth/email-change/verify`; on success calls
    `logout()` first to wipe the orphaned local cookie, then redirects
    to `/account/login?email-changed=success` so the login page
    renders a green "Имейл адресът на акаунта Ви беше променен
    успешно" banner. Race-handles a token going dead between mount-
    check and submit by transitioning to the dead-link UI.
    Intentionally NOT auto-fired on mount (email-client scanners would
    burn the token).
  - `proxy.ts` `PUBLIC_ACCOUNT_PATHS` — added
    `/account/email-change/verify` to the anonymous-allowed list. The
    request page (`/account/email-change`) is correctly gated by the
    proxy as authenticated.
  - `app/(shop)/account/profile/page.tsx` — the email-row helper text
    that used to say "За промяна на имейл адреса се свържете с
    поддръжката" now links to `/account/email-change`.
  - The login page handles `?email-changed=success` alongside the
    existing `?reset=success`.
- **Password-change UI** wired end-to-end on the profile page:
  - `lib/auth/client.ts` — added `changePassword({ currentPassword,
    newPassword })`. New `same_password` variant on the `AuthError`
    discriminated union, alongside the already-present
    `breached_password`, `validation`, `invalid_credentials`,
    `account_locked`, and `network` kinds the new endpoint can emit.
  - `app/(shop)/account/profile/page.tsx` — the password section,
    previously a client-only mock with a "this endpoint will be
    available in a future version" disclaimer, is now wired to
    `POST /auth/change-password`. Three inputs (current, new,
    confirm) with `autoComplete="current-password"` and
    `autoComplete="new-password"` so password managers can offer
    "remember the new password" prompts. Client-side validation
    (non-empty, ≥12 chars, confirm matches) before round-trip;
    server is the source of truth for HIBP / same-password /
    current-password / lockout. Per-input inline errors with
    `aria-invalid` + `aria-describedby` so screen readers narrate
    them. Success state: clears the form (so a left-open tab can't
    be shoulder-surfed for the new password) and shows a green
    "Паролата е сменена успешно. Всички други устройства са
    излезли." banner that auto-dismisses after 5 seconds. The
    personal-data section above remains a stub awaiting a separate
    `PATCH /auth/me` slice.
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

- MFA for admin (admin-api is its own slice).
- Corporate registration UI + backend endpoint.
- Account deletion / GDPR anonymization.
- Profile-data edit (`PATCH /auth/me` for fullName/phone). The
  password-change endpoint shipped May 22 2026.
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
