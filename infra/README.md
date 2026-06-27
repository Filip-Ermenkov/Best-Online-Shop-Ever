# infra/ — Terraform for the first production deploy

This is the Infrastructure-as-Code for [`docs/ARCHITECTURE.md` §15 roadmap item
17](../docs/ARCHITECTURE.md): *"First production deploy."* It turns the prose
runbook in §2–§3 of the architecture doc into actual, version-controlled,
statically-validated Terraform.

## Status — read this first

**This Terraform has been authored, formatted, validated, linted,
security-scanned — and live-apply-validated on 2026-06-07**: a test
`terraform apply` deployed end-to-end and returned HTTP 200 through
CloudFront → OAC → Lambda (two apply-time fixes were folded back in; see the
root README "Known gaps"). The email queue (item 21) was additionally
**live-validated 2026-06-12** on the running stack (real SES delivery + the
DLQ → alarm → redrive drill). The scheduler slice (item 23, `scheduler.tf`)
shipped 2026-06-12 and was **live-validated 2026-06-13** on the running
stack against a Neon branch: all three job drills passed (catalog-backup
wrote the S3 object + `catalog_backups` row, pickup-expiry emailed the
verified inbox, unverified-cleanup ran clean). That drill also caught a
prod-only bug — the `neon-http` driver throws on `db.transaction(...)` —
fixed by switching the runtime to the Neon serverless WebSocket driver
(`backend/db/src/client.ts`); rebuild the bundle + re-apply to ship it.
Distributed tracing (item 18, `enable_tracing`) shipped + was live-validated
2026-06-13. **SLOs as code + multi-window burn-rate alarms** (items 24/25,
`slos.yaml` + `slo.tf`, `enable_slo_alarms`) shipped 2026-06-14 — defined and
apply-ready; the budgets need live traffic to exercise (runbook below).
What does NOT exist yet is a *maintained* production environment: custom
domain, frontend deployed (the Neon schema and the test stack now exist).
Applying requires AWS credentials, a Neon project, and (optionally) a domain,
which only the owner has.

What "validated" means concretely (all run in CI via
[`.github/workflows/infra.yml`](../.github/workflows/infra.yml) and reproducible
locally — see [Verifying](#verifying-without-applying)):

- `terraform fmt -check -recursive` — canonical formatting.
- `terraform validate` — types, references, and provider-schema correctness.
- `tflint` — provider-aware lint (deprecations, invalid enums, naming).
- `checkov` — static security/compliance scan (see `.checkov.yaml` for the small
  set of consciously-accepted findings, each with a justification).

## What it provisions

Default apply (`enable_cdn = true`, everything else off) gives you a running,
observable API behind CloudFront with no DNS or domain required:

| Resource | File | Notes |
|---|---|---|
| KMS CMK (+ alias) | `kms.tf` | Encrypts the log group, Lambda env, and the DB-URL secret. `enable_kms_cmk=false` → AWS-managed keys, €0. |
| SSM SecureString `DATABASE_URL` | `ssm.tf` | The one runtime secret. Placeholder-seeded; real value set out-of-band. |
| `shop-api` Lambda (Node 22, arm64) | `lambda.tf` | Handler `handler.handler`; active X-Ray tracing (+ optional app-level OpenTelemetry via `enable_tracing`); env from vars + SSM. |
| Lambda Function URL | `lambda.tf` | `AWS_IAM`-only when the CDN is on (reachable only via CloudFront OAC). |
| CloudWatch Log Group (14d) | `lambda.tf` | Pre-created so retention + CMK encryption are enforced. |
| Lambda execution role | `iam.tf` | Least privilege: own-log-group writes, one SSM param, scoped SES, CMK decrypt. |
| CloudFront + OAC (+ ACM) | `cdn.tf` | sigv4-signs origin requests; default `*.cloudfront.net` domain unless `api_domain_name` is set. |
| SNS topic + 8 CloudWatch alarms | `observability.tf` | 5xx-rate, p99 duration, SES bounce; admin-login gated until admin-api exists; email DLQ-depth + queue-age ship with `enable_email_queue`; scheduler-fn-errors + scheduler-delivery-failures ship with `enable_scheduler`. |
| GitHub OIDC provider + deploy role | `cicd.tf` | CI assumes it to ship Lambda code — no long-lived AWS keys. Covers `email-fn` and `scheduler-fn` too when their flags are enabled. |
| SLO SLI filters + burn-rate alarms | `slo.tf` | Logs metric filters over the `request_end` line + multi-window multi-burn-rate composite alarms (availability / order-success / latency). Ships with `enable_slo_alarms`; requires `log_level = "info"`. Contract in `slos.yaml`; roadmap items 24/25 (runbook below). |

Opt-in layers (all `enable_* = false` by default): **WAF** (`waf.tf`), **Route 53**
(`dns.tf`), **Amplify** frontend hosting (`amplify.tf`), **SES** domain identity
+ DKIM + MAIL FROM (`ses.tf`), the **durable email queue** — SQS + DLQ
(`sqs.tf`) + the `email-fn` consumer Lambda (`email-fn.tf`), roadmap item 21
(see below) — and the **scheduled jobs** — `scheduler-fn` + three EventBridge
Scheduler crons + delivery DLQ + catalog-backup bucket (`scheduler.tf`),
roadmap item 23 (runbook below) — and **distributed tracing**
(`enable_tracing` — app-level OpenTelemetry on `shop-api` + the ADOT collector
layer, wired in `lambda.tf`), roadmap item 18 (runbook below) — and the **SLO burn-rate alarms**
(`enable_slo_alarms` — `slo.tf` + the OpenSLO contract `slos.yaml`), roadmap
items 24/25 (runbook below). Each is
documented at its variable in `variables.tf`. The §10 cost model prefers
Cloudflare for DNS+WAF, which is why those AWS-native paths ship off.

## Prerequisites

- An AWS account + credentials (`aws configure` or SSO) with rights to create the
  resources above. **First apply uses a privileged local identity**; afterwards CI
  uses the narrower OIDC deploy role for code pushes.
- Terraform **≥ 1.11** (native S3 state locking). Authored on 1.15.5.
- A **Neon** Postgres project (the DB is not an AWS resource). Have its pooled
  connection string ready.
- *(Optional)* a domain if you want `api.<domain>` instead of the CloudFront
  default, and/or SES email.

## Apply order

```bash
cd infra

# 0. One-time: create the encrypted S3 state bucket (uses local state).
cd bootstrap
terraform init
terraform apply
terraform output backend_hcl          # copy this …
cd ..
cp backend.hcl.example backend.hcl    # … into backend.hcl

# 1. Build the Lambda artifact(s) the stack zips (see the native-dep note below).
cd ../backend/shop-api && npm run build:lambda && cd ../../infra
# …and, ONLY if enable_email_queue = true (pure JS, builds on any OS):
cd ../backend/email && npm run build:lambda && cd ../infra

# 2. Configure and apply the main stack.
cp terraform.tfvars.example terraform.tfvars   # edit (NO secrets)
terraform init -backend-config=backend.hcl
terraform plan
terraform apply

# 3. Put the REAL Neon URL into SSM (it is never in tfvars/state via this path).
aws ssm put-parameter --type SecureString --overwrite \
  --name "$(terraform output -raw database_url_param_name)" \
  --value 'postgresql://USER:PASS@ep-xxx-pooler.eu-central-1.aws.neon.tech/shop?sslmode=require'

# 4. Re-apply so the Lambda picks up the value, or just bounce the function.
terraform apply

git add .terraform.lock.hcl && git commit -m "chore(infra): lock provider versions"
```

The frontend URL to point the browser/Amplify at is `terraform output api_public_url`.

### The native dependency (argon2)

The shop-api bundle has exactly one native module: `argon2`. Its compiled binary
must match the Lambda's architecture (default **arm64**). Build on a matching
Linux host — GitHub's `ubuntu-24.04-arm` runner for arm64, or set
`lambda_architecture = "x86_64"` and build on a normal x64 runner. `build.mjs`
marks `@aws-sdk/*` external (the Node 22 runtime provides it) and installs argon2
into `dist/node_modules` for the build platform. The **email-fn bundle has no
native dependency** — `backend/email/build.mjs` is a plain esbuild pass that
works from any OS, including the Windows dev box.

## Durable email queue (roadmap item 21)

Closes the EU 2023/2673 durable-medium audit margin (mandatory **2026-06-19**):
with `EMAIL_TRANSPORT=sqs`, shop-api enqueues every rendered email onto an SQS
queue and the `email-fn` Lambda performs the SES send with retry. A failed send
redelivers (visibility 180 s, `maxReceiveCount` 5 — both per AWS prescriptive
guidance) and then parks in the DLQ, where the `email-dlq-depth` alarm fires.

To enable on a stack:

```hcl
# terraform.tfvars
enable_email_queue = true
email_transport    = "sqs"   # precondition: rejected unless the queue is enabled
```

```bash
cd ../backend/email && npm run build:lambda && cd ../infra   # bundle first
terraform apply
```

The stack wires `EMAIL_QUEUE_URL` into shop-api automatically (output
`email_queue_url`). The event source mapping uses partial-batch responses
(`ReportBatchItemFailures`) so one failed email never blocks or re-sends its
batch-mates, and caps consumer concurrency at 2 to stay friendly to SES rate
limits. Both queues are SSE-KMS-encrypted with the project CMK (rendered emails
are personal data); `email-fn`'s role can consume the queue and call SES —
no DB, no SSM.

**When the DLQ alarm fires:** inspect the message in the SQS console
(`email_dlq_url` output), fix the cause (e.g. unverified sender, SES outage
over), then use the console's **Start DLQ redrive** → messages flow back to the
source queue and deliver. Messages live 14 days in both queues, so there is a
two-week window to notice and redrive before anything is truly lost.

## Scheduled jobs runbook (roadmap item 23)

Three EventBridge Scheduler crons (group `<prefix>-jobs`, all
**Europe/Sofia** — DST handled by the service) async-invoke the
`scheduler-fn` Lambda with `{"job":"…"}`:

| Schedule | Cron (Sofia) | Job |
|---|---|---|
| `<prefix>-pickup-expiry` | `0 * * * ? *` | Claim expired `ready_for_pickup` orders → ONE admin email each (order not transitioned — spec §7 manual decision) |
| `<prefix>-catalog-backup` | `0 3 * * ? *` | Catalog JSON → `s3://<catalog_backup_bucket>/catalog/<YYYY-MM-DD>.json` + a `catalog_backups` row |
| `<prefix>-unverified-cleanup` | `0 4 * * ? *` | Day-6 warning email, day-7 hard delete of unverified customers, 180-day `login_attempts` prune |

To enable on a stack:

```hcl
# terraform.tfvars
enable_scheduler = true   # alarms ride along (enable_scheduler_alarms defaults true)
```

```bash
cd ../backend/shop-api && npm run build:scheduler && cd ../../infra  # bundle first
terraform apply
```

**Manual drill (don't wait for a cron tick):** the schedules invoke the
function asynchronously, but you can invoke it synchronously and read the
result right back:

```bash
aws lambda invoke --function-name <prefix>-scheduler-fn \
  --cli-binary-format raw-in-base64-out \
  --payload '{"job":"catalog-backup"}' /dev/stdout
```

A clean run returns the job's counters (e.g. `{"bucket":…,"key":…}`); a
failing run returns the error — same thing the alarm pair watches.

**Failure lanes (two alarms, disjoint by design):**

- `scheduler-fn-errors` — a JOB threw (DB unreachable, missing bucket, bug).
  Async invoke ⇒ Lambda retries twice, then the `Errors` metric trips the
  alarm. Look for the `job_failed` event in the function's log group. There
  is NO redrive to run: fix the cause and either wait for the next tick or
  re-invoke manually (above) — every job is an idempotent sweep.
- `scheduler-delivery-failures` — EventBridge Scheduler could not hand the
  event to Lambda at all; after the retry policy (3 attempts / 30 min) the
  invocation parks in the scheduler DLQ (`scheduler_dlq_url` output).
  Inspect the message attributes (error code) and the invoke role.

**With no real database attached** (the SSM `DATABASE_URL` still holding the
placeholder), every job run fails at DB connect — *loudly, by design*: the
first cron tick after an `enable_scheduler` apply lights the
`scheduler-fn-errors` alarm, which IS the alarm-path validation. As of
2026-06-13 the running stack HAS a Neon branch attached and all three drills
passed, so leaving `enable_scheduler = true` is the correct steady state.
Note: the runtime uses the Neon serverless **WebSocket** driver for
transactions, which cannot do pg-level channel binding — `createDb()` strips
`channel_binding=require` from the URL, so the pooled SSM value works whether
or not it carries that parameter.

## Image upload runbook (roadmap item 46)

The catalog-image upload pipeline: a private **assets bucket** (`pending/`
upload target + `uploads/` served prefix), a **CloudFront + OAC** distribution
that serves only `uploads/` (via `origin_path`), and the **assets-fn** validator
Lambda that magic-byte-checks each upload and promotes only genuine images. The
browser uploads straight to S3 with a presigned POST minted by shop-api
(`POST /admin/uploads`); the bytes never pass through a Lambda.

To enable on a stack:

```hcl
# terraform.tfvars
enable_asset_uploads       = true
asset_cors_allowed_origins = ["https://shop.example.com"]  # REQUIRED — the storefront/admin origin(s)
# asset_max_upload_mb          = 10   # optional (default 10)
# asset_pending_retention_days = 1    # optional (default 1)
```

```bash
cd ../backend/shop-api && npm run build:assets && cd ../../infra  # bundle first
terraform apply
```

On apply, Terraform wires shop-api automatically: `ASSET_UPLOAD_BUCKET` is set,
and `CDN_BASE_URL` is pointed at the new assets distribution (unless
`cdn_base_url` is set to a custom domain / R2 — that wins). The outputs
`assets_bucket`, `assets_cdn_domain`, and `assets_cdn_url` report the created
resources.

**Manual drill (presign → upload → verify promotion):** with an admin session
cookie saved to `cookies.txt` (see the root README → "Admin authentication"):

```bash
# 1. Mint a presigned POST for a small JPEG.
#    body.json: {"kind":"products","contentType":"image/jpeg","contentLength":12345}
curl.exe -s -X POST https://<api-host>/admin/uploads -b cookies.txt \
  -H 'Content-Type: application/json' --data "@body.json"
#    → { "url":"https://<bucket>.s3...", "fields":{...}, "storedKey":"products/<uuid>.jpg", ... }

# 2. Upload the file straight to S3 with the returned fields (file LAST).
curl.exe -s -X POST "<url>" \
  -F key="<fields.key>" -F Content-Type=image/jpeg \
  -F Policy="<fields.Policy>" -F X-Amz-Signature="<fields['X-Amz-Signature']>" \
  ... (all fields) ... \
  -F file=@photo.jpg
#    → 204 (S3 accepted it into pending/)

# 3. Poll until the validator has promoted it (usually < 1s).
curl.exe -s "https://<api-host>/admin/uploads/status?key=products/<uuid>.jpg" -b cookies.txt
#    → { "key":"products/<uuid>.jpg", "ready":true }

# 4. The image is now served at CDN_BASE_URL/products/<uuid>.jpg.
```

To prove the security gate, repeat step 2 with a non-image renamed `.jpg`: the
upload still returns 204 (S3 accepts the bytes), but step 3 stays `ready:false`
forever — the `asset_rejected` log line in the `assets-fn` log group shows the
object was deleted, never promoted.

**Failure lane (one alarm):** `assets-fn-errors` — a validation invoke threw (an
unexpected S3 fault or a bug). The bucket invokes the function asynchronously, so
in-function failures surface only on the Lambda `Errors` metric. There is no DLQ
by design: a rejected object is deleted (so it cannot re-trigger), and a transient
fault is retried by the async invoke. Look for the `asset_rejected` / `asset_
promoted` events in the function's log group.

Notes: the bucket is private (public access blocked, OAC-only); `pending/` is
unreachable through the CDN (the distribution's `origin_path` is `/uploads`), and
its objects are lifecycle-expired after `asset_pending_retention_days`. The shop-
api role can `PutObject` only under `pending/*` (it signs the presigned POST) and
`GetObject` only under `uploads/*` (the status HEAD); the assets-fn role can read
`pending/*`, write `uploads/*`, and delete `pending/*` — nothing else.

**Three prerequisites that separate "deployed" from "actually serves an image"**
(all now in code after the 2026-06-27 live validation — listed so a future change
doesn't quietly undo them):

1. **With `enable_kms_cmk = true` (the default), CloudFront needs a KMS grant.**
   The assets bucket is SSE-KMS, so CloudFront's OAC fetch must `kms:Decrypt`, and
   the CloudFront *service* principal can only be granted that in the KMS **key
   policy** (`kms.tf` → `AllowCloudFrontDecryptAssets`), never via IAM. Without it
   every image returns **403 at the edge** even though the upload, validation, and
   promotion to `uploads/` all succeeded.
2. **`asset_cors_allowed_origins` is the BROWSER PAGE origin — not the CDN domain.**
   It is the origin the admin/storefront HTML is served from (e.g.
   `https://shop.example.com`, or `http://localhost:3000` when driving the UI
   locally) — the page that issues the cross-origin POST to S3. Pointing it at the
   assets CDN domain makes every upload fail CORS in the browser.
3. **The frontend CSP must allow both hops.** `frontend/src/proxy.ts` reads
   `NEXT_PUBLIC_ASSET_S3_ORIGIN` (added to `connect-src` — the direct upload) and
   `NEXT_PUBLIC_ASSET_CDN_ORIGIN` (added to `img-src` — the rendered image); set
   both in the frontend env to the `assets_bucket` S3 endpoint and `assets_cdn_url`.
   Separately, the `assets-fn` validator is intentionally **DB-free** (it has no
   `DATABASE_URL`) — any import that transitively pulls in `parseEnv()` crashes it
   on cold start, so it promotes nothing (see ARCHITECTURE §13).

## Tracing runbook (roadmap item 18)

App-level OpenTelemetry on `shop-api`: `@hono/otel` request spans + undici/fetch
downstream spans + Pino `trace_id`/`span_id` log correlation (see
ARCHITECTURE.md §8.2 + §13). Off by default; flipping it on is two variables
plus a redeploy.

**Enable (export to X-Ray):**

1. Pick the **collector-only** ADOT layer ARN for this region + architecture
   from <https://github.com/aws-observability/aws-otel-lambda> (the
   `aws-otel-collector-<arch>-ver-x-y-z` layers). **The arch token MUST match
   `lambda_architecture`** — the collector is a native binary, so an arm64 layer
   on an x86_64 function (or vice-versa) crashes the extension at init with
   `/opt/extensions/collector: cannot execute binary file` → `Extension.Crash`
   → every request 502s. AWS names the x86 build `amd64`:
   - x86_64 function → `...:layer:aws-otel-collector-amd64-ver-0-117-0:1`
   - arm64 function → `...:layer:aws-otel-collector-arm64-ver-0-117-0:1`

   Confirm the exact version (`ver-x-y-z`) and layer-version suffix (`:N`, which
   can differ between the two arches) on the releases page; ARNs go stale. A
   plan-time precondition in `lambda.tf` blocks an obvious arch mismatch, but
   double-check against `aws lambda get-function-configuration … --query
   Architectures` if in doubt.
2. In `terraform.tfvars`:

   ```hcl
   enable_xray_tracing      = true   # required — the X-Ray write IAM rides on this
   enable_tracing           = true
   # arch MUST match lambda_architecture — amd64 shown for the x86_64 default:
   adot_collector_layer_arn = "arn:aws:lambda:eu-central-1:901920570463:layer:aws-otel-collector-amd64-ver-0-117-0:1"
   ```

3. Rebuild + redeploy the `shop-api` bundle (the OTel deps ship inside it):
   `npm --workspace @shop/api run build:lambda`, then `terraform apply`.

Terraform then sets `ENABLE_TRACING=true`, `OTEL_TRACES_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, and attaches the layer.
The app exports OTLP to the collector extension on `localhost:4318`; the
collector forwards to X-Ray with the IAM from the existing
`AWSXRayDaemonWriteAccess` attachment. We deliberately do **not** set
`AWS_LAMBDA_EXEC_WRAPPER` — `shop-api` self-instruments in-bundle, so the
layer's auto-instrumentation must stay off (no double-wrapping). The
collector-only layer runs the collector as an auto-started extension; no
custom collector config is needed (its default OTLP-receiver → `awsxray`
exporter is exactly the path we use).

**Correlation-only (no X-Ray, no layer):** set `enable_tracing = true` and
leave `adot_collector_layer_arn = ""`. Terraform sets
`OTEL_TRACES_EXPORTER=none`: spans are created (so CloudWatch Logs carry
`trace_id`/`span_id` for Logs-Insights correlation) but nothing is exported.

**Validation drill:**

1. After the apply, make a request through CloudFront
   (`curl -s https://<dist>.cloudfront.net/health`).
2. **X-Ray console → Traces:** within a minute you should see a trace whose
   root is the Lambda segment, with the `GET /health` Hono span beneath it
   (and, on a DB-touching route, the Neon/HIBP `fetch` subsegments). The span
   carries `app.request_id` = the request's `X-Request-Id`.
3. **CloudWatch Logs** for `/aws/lambda/<prefix>-shop-api`: the `request_start`
   / `request_end` lines for that invocation carry the same `trace_id`. That
   `X-Request-Id` ↔ trace ↔ logs match is the whole point.

**Cost & notes:** X-Ray is priced per trace recorded — negligible at this
shop's volume; cap with `OTEL_TRACES_SAMPLER` (a standard OTel env var the SDK
honours) if traffic ever grows. This path uses the collector → classic X-Ray
segment, so **Transaction Search is not required**. The alternative
collector-less direct-to-X-Ray-OTLP-endpoint path (which needs SigV4 +
Transaction Search) is noted in ARCHITECTURE.md §13 as a deferred option.

**Disable:** set `enable_tracing = false` and re-apply (or just drop
`adot_collector_layer_arn` for correlation-only). With the flag off the OTel
graph is never evaluated — zero request-path cost.

## SLO + burn-rate runbook (roadmap items 24/25)

The objective contract is `slos.yaml` (OpenSLO v1 — availability,
order-placement success, p95 latency). `slo.tf` is its CloudWatch
implementation: five Logs metric filters over the `request_end` log line, then
multi-window multi-burn-rate alarms. Off by default.

**What it provisions (only when `enable_slo_alarms = true`):**

- **Metric filters** (namespace `<project>-<env>/slo`): `SLIRequests`,
  `SLIRequests5xx`, `SLIRequestDurationMs`, `SLIOrdersPlaced`,
  `SLIOrdersFailed` — all read from the one structured `request_end` line the
  API already emits (`{ method, path, status, durationMs }`).
- **Availability** — both burn tiers: `…-slo-availability-fast-burn`
  (composite of the 1h + 5m arms, 14.4× budget → **page**) and
  `…-slo-availability-slow-burn` (6h + 30m, 6× → **ticket**).
- **Order-success** — `…-slo-orders-fast-burn` (composite 1h + 5m, page). A 5xx
  on `POST /orders` is a lost sale.
- **Latency** — `…-slo-latency-p95` (single alarm, p95 over 15 min > threshold).

All notify the existing alarms SNS topic. The per-window child alarms carry **no
actions** — only the composites page, so a single flapping arm never reaches you.

**Enable (two settings — both required):**

```hcl
enable_slo_alarms = true
log_level         = "info"   # the SLIs read the INFO-level request_end line
```

`log_level` defaults to `warn`, at which `request_end` is suppressed and the
filters see nothing. A plan-time **precondition** on the `SLIRequests` filter
fails the apply with a clear message if you enable the alarms without
`log_level = "info"`, so you cannot get this wrong silently. Then:

```powershell
terraform apply
terraform output slo_alarm_names   # the composite + latency alarm names
```

**Tune the targets** (optional) via `slo_availability_target` (default 0.999),
`slo_orders_target` (0.999), `slo_latency_threshold_ms` (1000). The burn-rate
alarm thresholds are derived from these (e.g. availability fast-burn fires when
the 5xx rate exceeds `14.4 × (1 − target) = 1.44%` in **both** the 1h and 5m
windows).

**Validate on a live stack:** drive some 5xx (e.g. hit a route that 500s, or
temporarily break `DATABASE_URL`). Within ~5 minutes the short-window arm
(`…-slo-availability-fast-5m`) flips to ALARM; once the 1h arm also crosses,
the **composite** fires and SNS notifies. Restore service and the short window
clears the composite quickly. The CloudWatch console → Alarms shows the
composite's child state. Note: with **no traffic** every alarm sits in
INSUFFICIENT_DATA / OK (`treat_missing_data = notBreaching`) — quiet is healthy,
not a false page.

**Cost:** composite alarms bill ~$0.50/mo each (3 composites) and the metric
alarms count against the 10 always-free CloudWatch alarm allowance; gated off,
the cost is $0 until enabled. **Caveat (documented trade-off):** the window
alarms use period = window length / `evaluation_periods = 1` (the same shape as
the existing `api-5xx-rate` alarm), so the long-window arm evaluates on a
clock-aligned cadence rather than a Prometheus-style rolling window. The short
window drives fast detection; a finer rolling burn-rate, or AWS Application
Signals SLOs, is the documented next step (`slos.yaml` header + ARCHITECTURE
§8.5 / §13).

**Disable:** set `enable_slo_alarms = false` and re-apply — every filter and
alarm is removed; the `request_end` log enrichment (harmless, additive) stays.

## How secrets are handled

Only `DATABASE_URL` is a secret. Terraform creates the SSM SecureString with a
placeholder and `lifecycle.ignore_changes = [value]`, so the real URL never
enters a plan, the state, or git through that resource. You set it once with
`aws ssm put-parameter` (step 3).

**One honest trade-off:** to keep the app's existing `process.env.DATABASE_URL`
contract with zero code change, the stack reads the parameter back via a data
source and injects it into the Lambda env — which places the decrypted value into
Terraform state. That is acceptable *only* because state lives in the encrypted,
access-restricted, TLS-only S3 bucket from `bootstrap/`. The forward hardening
(documented, not yet done) is to have the Lambda fetch the parameter from SSM at
cold start, removing it from state entirely; the Lambda role already carries
`ssm:GetParameter` + `kms:Decrypt`, so that is a one-file app change with no IAM
work.

## Verifying without applying

You do not need AWS to check this code. From `infra/`:

```bash
terraform fmt -check -recursive
terraform init -backend=false        # provider schemas, no remote state
terraform validate
tflint --recursive
checkov -d . --quiet
```

CI runs the same set on every PR touching `infra/`.

## Cost

At the documented low tiers the AWS side is ~€0–1/mo (the CMK is the only
fixed line, ~$1/mo; set `enable_kms_cmk=false` to drop it). The real recurring
cost is Neon (~€18/mo at the Launch tier). See `docs/ARCHITECTURE.md` §10.

## Accepted findings & hardening backlog

Tracked honestly rather than silently skipped:

- **CloudFront access logging** is not configured (needs a logs bucket). Real
  gap; add an `aws_s3_bucket` + `logging_config` when you want request-level
  edge logs. Until then, the Lambda log group + (optional) WAF metrics cover
  observability.
- **WAF is off by default.** The cost model prefers Cloudflare's free WAF. Turn
  on `enable_waf` for the AWS-native managed rule sets.
- **Default-cert CloudFront** (no custom domain) can't pin a minimum TLS version
  — inherent to `*.cloudfront.net`. Set `api_domain_name` for TLS 1.2_2021.
- **email-fn and scheduler-fn ship with NO reserved concurrency** (CKV_AWS_115,
  skipped inline in `email-fn.tf` / `scheduler.tf`). A reservation draws from
  the account-wide concurrency pool; with shop-api already reserving 50,
  small/new AWS accounts hit
  `InvalidParameterValueException … below its minimum value` at apply time. The
  binding throttle for email-fn is the SQS event source mapping's
  `maximum_concurrency = 2` (pool-free), and nothing but that mapping can
  invoke it; scheduler-fn's concurrency is naturally ≤1 per schedule (three
  crons, one async invoke each). To add the defence-in-depth cap later: raise
  the account quota (Service Quotas → AWS Lambda → *Concurrent executions* —
  free, takes a day), then set `email_fn_reserved_concurrency`.
- **scheduler-fn has no function-level async DLQ** (CKV_AWS_116, register +
  inline note in `scheduler.tf`): every job is an idempotent full-scan sweep,
  so the next cron tick IS the redrive — a parked copy of `{"job":"…"}` adds
  nothing. Failures alarm instead: in-function errors on the Lambda `Errors`
  metric (the Scheduler invokes async, so they can ONLY surface there), and
  delivery failures in the scheduler DLQ via each schedule's retry policy.
- **EventBridge Scheduler schedules are not CMK-encrypted** (CKV_AWS_297,
  skipped inline in `scheduler.tf`): the only data a schedule stores is its
  static, non-sensitive input — `{"job":"<name>"}`, the same job names that are
  in the Terraform source and git. No PII, secret, or customer data ever passes
  through a schedule, so a customer-managed key would only add key-policy
  surface (granting `scheduler.amazonaws.com` decrypt) and apply-risk to the
  already-validated live schedules for zero confidentiality gain — the same
  value test as the CKV_AWS_116 skip above. Revisit if a schedule is ever given
  sensitive input.
- **The catalog-backup bucket skips access logging / replication / event
  notifications** (CKV_AWS_18 / CKV_AWS_144 / CKV2_AWS_62 — same register
  entries as the state bucket): private + versioned + TLS-only + SSE-KMS,
  written by exactly one role (write-only PutObject — scheduler-fn cannot
  read or delete history), single-region by GDPR design, and "backup didn't
  happen" is already covered by the scheduler-fn-errors alarm.
- **admin-api alarms** stay gated off because that Lambda doesn't exist as a
  separate function yet — the admin surface (auth + the 2026-06-10 orders
  slice) currently lives inside `shop-api` (item 22's remaining Lambda
  extraction). Flip `enable_admin_alarms` when it lands. The scheduler alarms
  joined the stack with item 23 (2026-06-12): they materialise with
  `enable_scheduler` (× `enable_scheduler_alarms`, default true).

These are recorded in `.checkov.yaml` where they correspond to a specific check.
