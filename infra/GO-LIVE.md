# Production go-live runbook

> The ordered cutover from today's ephemeral test stack to a **maintained**
> production environment (roadmap item 17). This complements
> `infra/README.md` — it does **not** duplicate the per-feature runbooks
> there ("Apply order", "Durable email queue", "Scheduled jobs", "Image
> upload", "Tracing", "SLO + burn-rate"). Where a step overlaps one of those,
> it points at it.
>
> Work top to bottom. Each phase gates the next. Times assume you already
> know this stack (you built it).

---

## Phase 0 — Decisions to make before touching AWS

Three decisions bind everything downstream. Make them first.

### 0.1 Frontend deploy target — resolved: **OpenNext v3 on Terraform**

`enable_amplify` / `infra/amplify.tf` is now a **dead path**: AWS Amplify
Hosting supports Next.js only up through 15, and this frontend is Next.js 16.
Deploy the frontend with **OpenNext** (which builds Next 16 SSR into a Lambda +
S3 + CloudFront bundle) provisioned via a **Terraform** module, so the whole
stack stays in one IaC tool and your `fmt`/`validate`/`tflint`/`checkov` gate
still covers it.

- Module: `RJPearson94/terraform-aws-open-next` (`tf-aws-open-next-zone`,
  single-zone, OpenNext v3) or the NHS England `terraform-aws-opennext`
  module. Both take the `.open-next/` build output and stand up the server
  function, image-optimisation function, static assets bucket, and CloudFront.
- Rejected alternatives: **SST** (wraps OpenNext but is a second IaC
  framework — fractures your Terraform stack and its CI gate); **the
  first-party Next.js AWS adapter** (GA "later in 2026", not yet — adopt it
  when it ships, it is a low-risk migration because OpenNext co-designed the
  16.2 Adapter API); **staying on Amplify + downgrading to Next 15**
  (regressive).
- Done: `infra/frontend.tf` implements this — the `tf-aws-open-next-zone` module +
  the us-east-1 ACM cert, gated on `enable_frontend`; `amplify.tf` is deprecated in
  place. Build `frontend/.open-next` (`npx open-next build`) before applying, and
  validate the cert in two steps (see the `frontend.tf` header).

### 0.2 Domain origins are env-driven — set them at build

`frontend/src/proxy.ts` no longer hardcodes any domain (fixed 2026-07-13). The
strict CSP now derives its origins from env: `connect-src` reuses
`NEXT_PUBLIC_SHOP_API_URL` (the same value the fetch client uses, so the two can
never drift) and `img-src` reads `NEXT_PUBLIC_IMG_ORIGIN` — each falling back to
the `duda1.shop` host when unset. Pointing the shop at the domain is now a
build-time env edit, never a code edit. Set both at the frontend build (Phase 4):

```
NEXT_PUBLIC_SHOP_API_URL = https://shop-api.duda1.shop
NEXT_PUBLIC_IMG_ORIGIN   = https://cdn.duda1.shop
```

Get these wrong (or leave them unset while deploying under a different domain)
and the browser CSP will **silently block every API call and image** in
production.

### 0.3 Keep frontend + API same-site (cookie constraint)

Auth cookies are `__Host-` prefixed and `SameSite=Lax`, and the API's CORS
allowlist (`cors_origins`) admits only the frontend origin. The storefront and
the API must therefore be the **same registrable site**:

| Surface | Host |
|---|---|
| Storefront | `duda1.shop` (or `shop.duda1.shop`) |
| API | `shop-api.duda1.shop` |
| Images CDN | `cdn.duda1.shop` |
| Admin (later, own Lambda) | `admin.duda1.shop` |

A frontend on a bare `*.cloudfront.net` with the API on `duda1.shop` will look
fine and then fail login. Don't split them.

---

## Phase 1 — Data plane: Neon production branch

1. Create the **production Neon branch** (not the test branch). Neon **Launch**
   (~€18/mo) is the practical entry tier; **Free** auto-suspends and is a SPOF —
   do not run prod on it.
2. **Rotate the exposed `neondb_owner` password** (the outstanding reminder in
   `backend/db/.env`). Reset it in the Neon console before it ever holds prod
   data.
3. Capture **both** connection strings: the **pooled** (`-pooler`, PgBouncer
   transaction mode) URL for the runtime, and the **direct** URL for
   migrations.
4. Apply the schema to the prod branch (migrations `0000`–`0005`):
   ```bash
   DATABASE_URL='postgresql://…direct…' npm run db:migrate
   ```
5. Seed the minimum a live shop needs (idempotent):
   - `npm --workspace @shop/api run admin:create` — the bootstrap admin
     (then enrol TOTP on first login).
   - Store settings defaults (phone, address, hours, pickup window,
     `admin_notification_email`) via the seed or the admin UI post-cutover.
   - If checkout reads a current Terms version, insert a baseline
     `tos_versions` row (the §9 ToS-management feature is not built yet —
     see the open items at the bottom).
6. Verify: `SELECT count(*) FROM information_schema.tables;` → 31 tables.

---

## Phase 2 — Secrets & config (SSM, out-of-band)

1. Set the real DB URL **out-of-band** so it never enters Terraform state
   (`database_url_placeholder` stays a placeholder):
   ```bash
   aws ssm put-parameter --name /best-online-shop-prod/DATABASE_URL \
     --type SecureString --overwrite --value 'postgresql://…-pooler…'
   ```
2. Same pattern for the **admin-MFA AES key** and any HMAC/challenge secrets.
3. Set the non-secret runtime vars via `terraform.tfvars` (not secrets):
   `cors_origins`, `email_from`, `public_app_base_url`, `email_transport`,
   `log_level`.

---

## Phase 3 — Backend Lambdas + edge

Follow `infra/README.md` → **"Apply order"**; this is the flag state a
maintained prod adds on top of today's test stack.

1. Build every bundle the enabled flags require:
   ```bash
   npm --workspace @shop/api   run build:lambda      # → dist/
   npm --workspace @shop/email run build:lambda      # → dist/  (email-fn)
   npm --workspace @shop/api   run build:scheduler   # → dist-scheduler/
   npm --workspace @shop/api   run build:assets      # → dist-assets/
   ```
2. Target flag state for prod (`terraform.tfvars`):

   | Flag | Test stack | **Prod** | Why |
   |---|---|---|---|
   | `enable_cdn` | true | **true** | OAC-signed CloudFront in front of the Function URL |
   | `enable_email_queue` | true | **true** | durable SES delivery |
   | `email_transport` | sqs | **sqs** | route mail through the queue |
   | `enable_scheduler` | true | **true** | the 3 Sofia-time crons |
   | `enable_asset_uploads` | true | **true** | product/banner images |
   | `enable_tracing` + `enable_xray_tracing` | true | **true** | set `adot_collector_layer_arn` for the region+arch |
   | `log_level` | — | **info** | required by `enable_slo_alarms` (the SLI metric filters read the INFO `request_end` line) |
   | `enable_slo_alarms` | false | **true** | turn on burn-rate paging once traffic is real |
   | `enable_ses` | false | **true** | DKIM + MAIL FROM + config set (Phase 5) |
   | `enable_dns` | false | **true / false** | true if Route 53; false if Cloudflare owns DNS (the §10 preference) |
   | `enable_waf` | false | **false / true** | false if Cloudflare fronts it; true for the AWS-native WAF |
   | `enable_admin_alarms` | false | false | leave until the admin-api Lambda exists |
   | `alarm_email` | — | **set it** | and confirm the SNS subscription email |
   | `lambda_reserved_concurrency` | -1 | **raise** | give the pooled account a real ceiling pre-prod |

3. `terraform apply`. Confirm the `s3:GetObject` grant on the catalog-backup
   bucket (the item-52 restore read) is applied — it was committed in `iam.tf`
   but must actually land in the live role.
4. Health check: `curl https://shop-api.duda1.shop/health` → `200`.

---

## Phase 4 — Frontend (OpenNext on Terraform)

1. Set the build-time env (from `terraform output`):
   ```
   NEXT_PUBLIC_SHOP_API_URL   = https://shop-api.duda1.shop
   NEXT_PUBLIC_SITE_URL       = https://duda1.shop
   NEXT_PUBLIC_ASSET_S3_ORIGIN = https://<assets_bucket>.s3.eu-central-1.amazonaws.com
   NEXT_PUBLIC_ASSET_CDN_ORIGIN = https://<assets_cdn>.cloudfront.net
   ```
   (The `ASSET_*` pair must match `proxy.ts`'s CSP allowances — Phase 0.2.)
2. Build OpenNext, then `terraform apply` the OpenNext module:
   ```bash
   cd frontend && npx open-next build      # → .open-next/
   ```
3. Point the storefront CloudFront at the site domain (Phase 6 wires DNS/TLS).
4. Double-check `robots.ts` emits `Disallow: /` on any **non-production** host
   so a preview URL never gets indexed.

---

## Phase 5 — Email deliverability (SES out of sandbox)

Per the Google/Yahoo/Microsoft 2026 bulk-sender rules — all four are hard
gates for inbox placement:

1. `enable_ses = true`, `ses_domain = duda1.shop`, apply → publish the **3 EasyDKIM
   CNAMEs**.
2. Custom **MAIL FROM** subdomain so SPF aligns with the visible `From:`.
3. **DMARC** at `_dmarc.duda1.shop` — start `p=none`, tighten to `p=quarantine`
   once reports are clean.
4. **Move the account out of the SES sandbox** (Service Quotas) so it can mail
   arbitrary recipients, not just verified identities.
5. Send one real order-confirmation end to end; confirm it lands in inbox (not
   spam) and the DKIM/SPF/DMARC pass in the headers.

**Receiving the shop's mailboxes.** SES above only *sends*. To *receive* mail at
the shop's addresses, use **Cloudflare Email Routing** (free) with a
**catch-all rule → one real inbox** (e.g. a Gmail) — one inbox to check, every
address works, no mailbox hosting fees. The code uses exactly four purposeful
addresses: `info@` (general / customer / legal notices), `security@`
(security.txt), `privacy@` (GDPR requests), `accessibility@` (EAA feedback). The
catch-all also answers the RFC 2142 `postmaster@` / `abuse@` a sending domain is
expected to accept. So the only "create the emails" step at go-live is: turn on
Email Routing and set one catch-all forward.

---

## Phase 6 — DNS + TLS

1. **ACM certificate for the frontend CloudFront must be in `us-east-1`**
   (CloudFront only reads certs there) — a separate cert from the API's. The
   API CloudFront cert requirement is the same.
2. Records (Route 53 or Cloudflare): `duda1.shop` / `shop.duda1.shop` → storefront
   CloudFront; `shop-api.duda1.shop` → API CloudFront; `cdn.duda1.shop` → assets
   CloudFront.
3. If Cloudflare fronts it (the §10 cost/security preference): proxy the records
   (orange cloud) for the free WAF + DDoS, and keep `enable_waf=false`.
4. Verify HSTS is served (`Strict-Transport-Security` — production build only)
   before considering preload.

---

## Phase 7 — Smoke test the live shop

Run against the real domain. Every one must pass:

- [ ] `GET /health` → 200; `GET /openapi.json` renders.
- [ ] Register → verify email (real SES) → log in; header re-renders with name.
- [ ] Add to cart (guest) → log in → cart merges.
- [ ] Place an order → confirmation page + **order-confirmation email** arrives.
- [ ] Guest checkout → `/track/<token>` shows status; lost-link resend works.
- [ ] Admin: log in → **TOTP MFA** → dashboard renders real KPIs.
- [ ] Admin: upload a product image → assets-fn promotes it → it renders from
      `cdn`/assets CDN (validates the presign → S3 → validator → CDN loop).
- [ ] Admin: edit a banner / a setting → storefront reflects it (edge cache ≤5 min).
- [ ] `GET /sitemap.xml` + `/robots.txt` correct; delete a product → its URL
      **301s** to the surviving target.
- [ ] Force a `503`/bad request → RFC 9457 problem body, correct status.

---

## Phase 8 — Prove reliability (roadmap item 19, first DR drill)

The snapshot-restore path (item 52) and Neon PITR make this real now.

1. **Neon PITR drill**: branch the prod DB to a timestamp, point a throwaway API
   at it, confirm data is intact. Record RPO/RTO. Write up the timestamped
   result (the §14 Operational-Excellence gap closes only when this is done).
2. **Catalog restore drill**: from `/admin/archive`, preview + restore a
   snapshot on a **staging** branch; confirm the diff/confirm/safety-backup flow
   behaves.
3. Trip one alarm on purpose (e.g. push the email DLQ) → confirm it pages the
   `alarm_email` SNS subscription, then redrive.
4. Confirm SLO burn-rate alarms are green against real traffic and X-Ray shows
   traces end to end.

---

## Phase 9 — Rollback triggers (decide before you need them)

| Symptom | Action |
|---|---|
| Bad frontend deploy | CloudFront serves the previous OpenNext build; re-`apply` the last good `.open-next`. |
| Bad API deploy | `aws lambda update-function-code` to the prior bundle, or `terraform apply` the last good ref. |
| Data corruption | Neon PITR branch to the last-good timestamp; repoint `DATABASE_URL` in SSM. |
| Catalog mistake | `/admin/archive` per-item restore or snapshot restore (item 52). |
| Email backlog | Inspect DLQ, fix, redrive (`infra/README.md` → email queue runbook). |

Keep the account root behind hardware MFA (the one out-of-scope threat in §5.1).

---

## Still open (not blockers, but know them)

- **§9 static-content management is unbuilt** — versioned Terms of Service +
  the forced customer re-acceptance modal. The `tos_versions` /
  `tos_acceptances` / `privacy_policy` tables are modelled but dormant, and it
  fell off the §15 roadmap. For a shop taking real orders, enforceable
  versioned Terms consent matters — schedule it right after go-live (or before,
  if your checkout blocks on a current ToS row).
- **Two settings follow-ups** — wire `admin_notification_email` into the admin
  notification sends; surface `default_pickup_deadline_days` as the
  `/admin/orders` "ready for pickup" prefill.
- **Cloudflare swap / CW retention 14d** (§15 items 26/27) — cost items, do
  after prod stabilises.
- **First-party Next.js AWS adapter** — migrate off OpenNext to it when it
  reaches GA later in 2026.
