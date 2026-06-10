# infra/ — Terraform for the first production deploy

This is the Infrastructure-as-Code for [`docs/ARCHITECTURE.md` §15 roadmap item
17](../docs/ARCHITECTURE.md): *"First production deploy."* It turns the prose
runbook in §2–§3 of the architecture doc into actual, version-controlled,
statically-validated Terraform.

## Status — read this first

**This Terraform has been authored, formatted, validated, linted, and
security-scanned. It has NOT been applied to a live AWS account yet** — no
deploy has happened. Applying it requires AWS credentials, a Neon project, and
(optionally) a domain, which only the owner has. Until someone runs
`terraform apply`, the architecture remains the documented hypothesis it always
was; this directory is the thing that makes that apply a 30-minute job instead
of a 2-day one.

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
| `shop-api` Lambda (Node 22, arm64) | `lambda.tf` | Handler `handler.handler`; active X-Ray tracing; env from vars + SSM. |
| Lambda Function URL | `lambda.tf` | `AWS_IAM`-only when the CDN is on (reachable only via CloudFront OAC). |
| CloudWatch Log Group (14d) | `lambda.tf` | Pre-created so retention + CMK encryption are enforced. |
| Lambda execution role | `iam.tf` | Least privilege: own-log-group writes, one SSM param, scoped SES, CMK decrypt. |
| CloudFront + OAC (+ ACM) | `cdn.tf` | sigv4-signs origin requests; default `*.cloudfront.net` domain unless `api_domain_name` is set. |
| SNS topic + 5 CloudWatch alarms | `observability.tf` | 5xx-rate, p99 duration, SES bounce; admin-login + scheduler alarms gated until those Lambdas exist. |
| GitHub OIDC provider + deploy role | `cicd.tf` | CI assumes it to ship Lambda code — no long-lived AWS keys. |

Opt-in layers (all `enable_* = false` by default): **WAF** (`waf.tf`), **Route 53**
(`dns.tf`), **Amplify** frontend hosting (`amplify.tf`), **SES** domain identity
+ DKIM + MAIL FROM (`ses.tf`). Each is documented at its variable in
`variables.tf`. The §10 cost model prefers Cloudflare for DNS+WAF, which is why
those AWS-native paths ship off.

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

# 1. Build the Lambda artifact the stack zips (see the native-dep note below).
cd ../backend/shop-api && npm run build:lambda && cd ../../infra

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

The bundle has exactly one native module: `argon2`. Its compiled binary must
match the Lambda's architecture (default **arm64**). Build on a matching Linux
host — GitHub's `ubuntu-24.04-arm` runner for arm64, or set
`lambda_architecture = "x86_64"` and build on a normal x64 runner. `build.mjs`
marks `@aws-sdk/*` external (the Node 22 runtime provides it) and installs argon2
into `dist/node_modules` for the build platform.

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
- **admin-api / scheduler-fn alarms** are gated off because those Lambdas don't
  exist as separate functions yet — the admin surface (auth + the 2026-06-10
  orders slice) currently lives inside `shop-api` (item 22's remaining Lambda
  extraction; scheduler-fn is item 23). Flip `enable_admin_alarms` /
  `enable_scheduler_alarms` when they land as their own Lambdas.

These are recorded in `.checkov.yaml` where they correspond to a specific check.
