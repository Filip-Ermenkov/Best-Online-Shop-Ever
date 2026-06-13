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

Opt-in layers (all `enable_* = false` by default): **WAF** (`waf.tf`), **Route 53**
(`dns.tf`), **Amplify** frontend hosting (`amplify.tf`), **SES** domain identity
+ DKIM + MAIL FROM (`ses.tf`), the **durable email queue** — SQS + DLQ
(`sqs.tf`) + the `email-fn` consumer Lambda (`email-fn.tf`), roadmap item 21
(see below) — and the **scheduled jobs** — `scheduler-fn` + three EventBridge
Scheduler crons + delivery DLQ + catalog-backup bucket (`scheduler.tf`),
roadmap item 23 (runbook below) — and **distributed tracing**
(`enable_tracing` — app-level OpenTelemetry on `shop-api` + the ADOT collector
layer, wired in `lambda.tf`), roadmap item 18 (runbook below). Each is
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
