# ─────────────────────────────────────────────────────────────────────────────
# Identity / tagging
# ─────────────────────────────────────────────────────────────────────────────

variable "project" {
  description = "Short project slug; prefixes every resource name."
  type        = string
  default     = "best-online-shop"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project))
    error_message = "project must be lowercase letters/digits/hyphens, 2-31 chars, starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment (prod, staging, …)."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be one of: prod, staging, dev."
  }
}

variable "aws_region" {
  description = "Primary AWS region. eu-central-1 (Frankfurt) for GDPR data residency."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like a valid region, e.g. eu-central-1."
  }
}

variable "tags" {
  description = "Extra tags merged into every resource's default_tags."
  type        = map(string)
  default     = {}
}

# ─────────────────────────────────────────────────────────────────────────────
# shop-api Lambda
# ─────────────────────────────────────────────────────────────────────────────

variable "lambda_runtime" {
  description = "Lambda Node.js runtime. node20.x security patches stopped 2026-04-30; 22.x is the current LTS (EOL 2027-04)."
  type        = string
  default     = "nodejs22.x"

  validation {
    condition     = contains(["nodejs22.x", "nodejs24.x"], var.lambda_runtime)
    error_message = "Use a runtime that still receives security patches: nodejs22.x or nodejs24.x."
  }
}

variable "lambda_architecture" {
  description = "Lambda CPU architecture. arm64 (Graviton) is ~20% cheaper and faster for this workload."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "lambda_memory_mb" {
  description = "Lambda memory (MB). CPU scales with memory; 512 is a sane Hono+Drizzle default."
  type        = number
  default     = 512

  validation {
    condition     = var.lambda_memory_mb >= 128 && var.lambda_memory_mb <= 10240
    error_message = "lambda_memory_mb must be between 128 and 10240."
  }
}

variable "lambda_timeout_s" {
  description = "Lambda timeout (seconds). Kept tight; the API does short request/response work."
  type        = number
  default     = 15

  validation {
    condition     = var.lambda_timeout_s >= 1 && var.lambda_timeout_s <= 900
    error_message = "lambda_timeout_s must be between 1 and 900."
  }
}

variable "lambda_bundle_dir" {
  description = "Path (relative to infra/) to the esbuild output dir produced by `npm run build:lambda` in @shop/api. Zipped at plan time."
  type        = string
  default     = "../backend/shop-api/dist"
}

variable "lambda_log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda log group. 14 days per the cost model (§10.4)."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.lambda_log_retention_days)
    error_message = "Must be a value CloudWatch Logs accepts (e.g. 1, 3, 5, 7, 14, 30, 90, 365…)."
  }
}

# ─── Non-secret runtime config injected as plain Lambda env vars ──────────────

variable "cors_origins" {
  description = "Comma-separated CORS allowlist (the deployed frontend origin)."
  type        = string
  default     = ""
}

variable "cdn_base_url" {
  description = "Base URL for product images (the image CloudFront/R2 origin). Empty = frontend placeholders."
  type        = string
  default     = ""
}

variable "log_level" {
  description = "Pino log level in production."
  type        = string
  default     = "warn"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level must be a valid Pino level."
  }
}

variable "email_transport" {
  description = "Email transport: sqs (prod target — durable queue + retry, requires enable_email_queue), ses (inline, single attempt), console, or stub."
  type        = string
  default     = "ses"

  validation {
    condition     = contains(["sqs", "ses", "console", "stub"], var.email_transport)
    error_message = "email_transport must be sqs, ses, console, or stub."
  }
}

variable "email_from" {
  description = "Verified SES sender, e.g. 'Best Online Shop <noreply@shop.example.com>'."
  type        = string
  default     = ""
}

variable "public_app_base_url" {
  description = "Public URL of the deployed frontend; used to build links inside emails."
  type        = string
  default     = ""
}

# ─── The one genuine secret (Parameter Store) ────────────────────────────────

variable "database_url_placeholder" {
  description = <<-EOT
    Initial value Terraform seeds into the DATABASE_URL SecureString parameter.
    DO NOT put the real Neon URL here — it would land in the Terraform plan and
    state. Leave the placeholder, apply, then set the real value out-of-band:
      aws ssm put-parameter --name /<project>-<env>/DATABASE_URL \
        --type SecureString --overwrite --value 'postgresql://…'
    Subsequent applies ignore changes to this value (lifecycle.ignore_changes).
  EOT
  type        = string
  default     = "REPLACE_VIA_AWS_SSM_PUT_PARAMETER"
}

# ─────────────────────────────────────────────────────────────────────────────
# Edge: CloudFront + ACM + WAF (in front of the API Lambda Function URL)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_cdn" {
  description = "Provision CloudFront in front of the Lambda Function URL with OAC (sigv4). Default true = secure-by-default: the Function URL becomes AWS_IAM-only and is not publicly reachable. With no api_domain_name it uses the default *.cloudfront.net domain (no ACM/DNS needed)."
  type        = bool
  default     = true
}

variable "api_domain_name" {
  description = "Custom domain for the API, e.g. api.shop.example.com. Requires enable_cdn."
  type        = string
  default     = ""
}

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_100 = NA+EU edge only (cheapest, fine for a Bulgarian shop)."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL (managed common + SQLi + rate-limit) to the API CloudFront distribution. The §10 cost model prefers Cloudflare's free WAF instead; this is the AWS-native path."
  type        = bool
  default     = false
}

variable "waf_rate_limit" {
  description = "WAF rate-based rule: max requests per 5-min window per source IP."
  type        = number
  default     = 2000
}

# ─────────────────────────────────────────────────────────────────────────────
# DNS: Route 53 (the §10 cost model documents Cloudflare as the preferred path)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_dns" {
  description = "Create a Route 53 hosted zone + records. Leave false if DNS lives in Cloudflare (the documented preference)."
  type        = bool
  default     = false
}

variable "root_domain_name" {
  description = "Apex domain for the Route 53 hosted zone, e.g. shop.example.com."
  type        = string
  default     = ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Frontend: AWS Amplify Hosting (Next.js 16 SSR)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_amplify" {
  description = "Provision an Amplify app + branch for the Next.js frontend. Needs a GitHub token; you can also connect the repo in the Amplify console instead."
  type        = bool
  default     = false
}

variable "amplify_repository_url" {
  description = "https URL of the GitHub repo Amplify builds, e.g. https://github.com/Filip-Ermenkov/Best-Online-Shop-Ever."
  type        = string
  default     = ""
}

variable "github_access_token" {
  description = "GitHub PAT with repo scope so Amplify can connect the repository. Sensitive; pass via TF_VAR_github_access_token, never commit."
  type        = string
  default     = ""
  sensitive   = true
}

variable "amplify_branch" {
  description = "Git branch Amplify builds and hosts."
  type        = string
  default     = "main"
}

# ─────────────────────────────────────────────────────────────────────────────
# CI/CD: GitHub Actions OIDC deploy role (no long-lived AWS keys)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_github_oidc" {
  description = "Create the GitHub OIDC provider + a least-privilege deploy role CI assumes to push Lambda code / run terraform apply."
  type        = bool
  default     = true
}

variable "github_owner" {
  description = "GitHub org/user that owns the repo."
  type        = string
  default     = "Filip-Ermenkov"
}

variable "github_repo" {
  description = "GitHub repository name."
  type        = string
  default     = "Best-Online-Shop-Ever"
}

variable "github_deploy_ref" {
  description = "Git ref allowed to assume the deploy role (OIDC sub condition). Keep it to the release branch."
  type        = string
  default     = "refs/heads/main"
}

# ─────────────────────────────────────────────────────────────────────────────
# Observability
# ─────────────────────────────────────────────────────────────────────────────

variable "alarm_email" {
  description = "Email subscribed to the alarms SNS topic. Empty = topic created, no subscription (subscribe later)."
  type        = string
  default     = ""
}

variable "enable_admin_alarms" {
  description = "Create the 'failed admin logins' alarm. Leave false until admin-api exists (it does not yet)."
  type        = bool
  default     = false
}

variable "enable_scheduler_alarms" {
  description = "Create the two scheduler-failure alarms (scheduler-fn Errors + Scheduler delivery DLQ) alongside the scheduler. Default true; they only materialise when enable_scheduler is also true (they reference its resources). Turn off solely to silence a known-noisy period."
  type        = bool
  default     = true
}

# ─── Distributed tracing (OpenTelemetry / ADOT, roadmap item 18) ─────────────

variable "enable_tracing" {
  description = "Switch on app-level OpenTelemetry tracing in shop-api (sets ENABLE_TRACING + the OTEL_* env). Distinct from enable_xray_tracing, which is the infra-level Lambda Active-tracing mode (the root segment): this is the app emitting its own request + downstream spans. Requires enable_xray_tracing=true (the X-Ray write IAM the collector needs rides on that attachment). Default off; zero cold-start cost when off (the OTel graph is never imported)."
  type        = bool
  default     = false
}

variable "adot_collector_layer_arn" {
  description = <<-EOT
    ARN of the AWS Distro for OpenTelemetry COLLECTOR Lambda layer for this
    region + architecture (e.g. arm64). When set (and enable_tracing=true) it is
    attached to shop-api and the app exports OTLP to the collector on
    localhost:4318, which forwards traces to AWS X-Ray — so OTEL_TRACES_EXPORTER
    flips to "otlp". When left empty, tracing still runs but exports nothing
    (OTEL_TRACES_EXPORTER="none"); spans are created so the Pino logs carry
    trace_id/span_id for CloudWatch Logs Insights correlation. Use the
    collector-only layer (aws-otel-collector-*), NOT a language auto-instrument
    layer — shop-api self-instruments in-bundle and must not be double-wrapped
    (we deliberately do not set AWS_LAMBDA_EXEC_WRAPPER). The layer's
    ARCHITECTURE must match lambda_architecture (the collector is a native
    binary): x86_64 → the "...-amd64-..." layer, arm64 → "...-arm64-...". A
    mismatch crashes the extension at init ("cannot execute binary file") and
    every request 502s — a plan-time precondition in lambda.tf now blocks the
    obvious mismatch. Pick the latest ARN from
    https://github.com/aws-observability/aws-otel-lambda. See
    infra/README.md → "Tracing runbook".
  EOT
  type        = string
  default     = ""
}

# ─── SLOs + multi-window multi-burn-rate alerting (roadmap items 24/25) ──────

variable "enable_slo_alarms" {
  description = "Provision the SLO SLI metric filters + multi-window multi-burn-rate burn-rate alarms (infra/slo.tf, contract in infra/slos.yaml). Default off. REQUIRES log_level = \"info\" — the SLIs are Logs metric filters over the INFO-level request_end line (a slo.tf precondition enforces it). Adds CloudWatch metric + composite alarms (composite alarms are billed at $0.50/mo each); zero cost when off."
  type        = bool
  default     = false
}

variable "slo_availability_target" {
  description = "Availability SLO target (non-5xx ratio), rolling 30 days. 0.999 = 99.9% (ARCHITECTURE §7.2). Drives the burn-rate alarm thresholds."
  type        = number
  default     = 0.999

  validation {
    condition     = var.slo_availability_target > 0.9 && var.slo_availability_target < 1
    error_message = "slo_availability_target must be between 0.9 and 1 (exclusive), e.g. 0.999."
  }
}

variable "slo_orders_target" {
  description = "Order-placement-success SLO target (non-5xx ratio on POST /orders), rolling 30 days. §7.2 aspires to 0.9995; 0.999 is the early-volume starting point."
  type        = number
  default     = 0.999

  validation {
    condition     = var.slo_orders_target > 0.9 && var.slo_orders_target < 1
    error_message = "slo_orders_target must be between 0.9 and 1 (exclusive), e.g. 0.999."
  }
}

variable "slo_latency_threshold_ms" {
  description = "Latency SLO: p95 request duration must stay under this many milliseconds. §7.2 aspires to 200ms warm; 1000ms leaves headroom for occasional Lambda cold starts."
  type        = number
  default     = 1000

  validation {
    condition     = var.slo_latency_threshold_ms >= 100 && var.slo_latency_threshold_ms <= 30000
    error_message = "slo_latency_threshold_ms must be between 100 and 30000."
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Email: SES domain identity (DKIM + custom MAIL FROM + config set)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_ses" {
  description = "Provision the SES domain identity, EasyDKIM, custom MAIL FROM, and a configuration set wired to CloudWatch (for the bounce-rate alarm)."
  type        = bool
  default     = false
}

variable "ses_domain" {
  description = "Domain to verify in SES, e.g. shop.example.com."
  type        = string
  default     = ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Email: durable delivery queue + email-fn consumer (roadmap item 21)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_email_queue" {
  description = "Provision the durable email queue (SQS + DLQ), the email-fn consumer Lambda and its alarms. Closes the EU 2023/2673 durable-medium audit margin (mandatory 2026-06-19). Requires the email-fn bundle (npm --workspace @shop/email run build:lambda); flip email_transport to sqs to route mail through it."
  type        = bool
  default     = false
}

variable "email_fn_bundle_dir" {
  description = "Path (relative to infra/) to the esbuild output dir produced by `npm run build:lambda` in @shop/email. Zipped at plan time when enable_email_queue = true."
  type        = string
  default     = "../backend/email/dist"
}

variable "email_queue_max_receive_count" {
  description = "Delivery attempts before a message parks in the email DLQ. AWS guidance: ≥5 with a Lambda consumer (transient throttles must not exhaust the budget)."
  type        = number
  default     = 5

  validation {
    condition     = var.email_queue_max_receive_count >= 2 && var.email_queue_max_receive_count <= 1000
    error_message = "email_queue_max_receive_count must be between 2 and 1000 (1 would DLQ on the first hiccup)."
  }
}

variable "email_fn_reserved_concurrency" {
  description = "Reserved concurrent executions for email-fn. -1 (default) = unreserved: reservations draw from the account-wide pool, and on small accounts (shop-api reserves 50; AWS enforces a minimum unreserved remainder) any reservation here can fail the apply. The SQS event source's maximum_concurrency (2) caps real concurrency without touching the pool. Set a small positive value only after raising the account quota (Service Quotas → Lambda → Concurrent executions); it must be ≥ 2 to stay above the ESM cap."
  type        = number
  default     = -1

  validation {
    condition     = var.email_fn_reserved_concurrency == -1 || var.email_fn_reserved_concurrency >= 2
    error_message = "email_fn_reserved_concurrency must be -1 (unreserved) or ≥ 2 (the event source mapping's maximum_concurrency)."
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Scheduled jobs: scheduler-fn + EventBridge Scheduler crons (roadmap item 23)
# ─────────────────────────────────────────────────────────────────────────────

variable "enable_scheduler" {
  description = "Provision scheduler-fn, the three EventBridge Scheduler crons (hourly pickup-expiry, daily catalog-backup, daily unverified-cleanup — Sofia time), the delivery DLQ, the catalog-backup S3 bucket, and (with enable_scheduler_alarms) the two failure alarms. Requires the scheduler bundle (npm --workspace @shop/api run build:scheduler)."
  type        = bool
  default     = false
}

variable "scheduler_fn_bundle_dir" {
  description = "Path (relative to infra/) to the esbuild output dir produced by `npm run build:scheduler` in @shop/api. Zipped at plan time when enable_scheduler = true."
  type        = string
  default     = "../backend/shop-api/dist-scheduler"
}

variable "catalog_backup_retention_days" {
  description = "Days a daily catalog snapshot is kept before the bucket lifecycle expires it. ARCHITECTURE §6.3 sets 90."
  type        = number
  default     = 90

  validation {
    condition     = var.catalog_backup_retention_days >= 7
    error_message = "catalog_backup_retention_days must be at least 7 (anything lower defeats the point of a daily backup history)."
  }
}

# ─── Image uploads (assets-fn pipeline, roadmap item 46) ─────────────────────

variable "enable_asset_uploads" {
  description = "Provision the catalog-image upload pipeline: a private assets S3 bucket (pending/ + uploads/ prefixes), a CloudFront+OAC distribution that serves only uploads/, and the assets-fn validator Lambda (magic-byte check → promote/delete). Wires shop-api to mint presigned POSTs and points CDN_BASE_URL at the new distribution. Requires the assets bundle (npm --workspace @shop/api run build:assets) and asset_cors_allowed_origins."
  type        = bool
  default     = false
}

variable "assets_fn_bundle_dir" {
  description = "Path (relative to infra/) to the esbuild output dir produced by `npm run build:assets` in @shop/api. Zipped at plan time when enable_asset_uploads = true."
  type        = string
  default     = "../backend/shop-api/dist-assets"
}

variable "asset_cors_allowed_origins" {
  description = "Origins allowed to POST a file to the assets bucket (the storefront/admin host[s], e.g. https://shop.example.com). Required when enable_asset_uploads = true — the browser presigned POST fails CORS without it."
  type        = list(string)
  default     = []
}

variable "asset_pending_retention_days" {
  description = "Days an un-validated object may linger in pending/ before the bucket lifecycle expires it. The validator normally promotes/deletes within seconds; this only sweeps abandoned uploads. 1 is plenty."
  type        = number
  default     = 1

  validation {
    condition     = var.asset_pending_retention_days >= 1
    error_message = "asset_pending_retention_days must be at least 1 (S3 lifecycle expiration is day-granular)."
  }
}

variable "asset_max_upload_mb" {
  description = "Hard cap on a single uploaded image, in MiB. Passed to shop-api as ASSET_UPLOAD_MAX_BYTES and enforced again in the S3 POST policy's content-length-range."
  type        = number
  default     = 10

  validation {
    condition     = var.asset_max_upload_mb >= 1 && var.asset_max_upload_mb <= 50
    error_message = "asset_max_upload_mb must be between 1 and 50 (a product photo, not an archive)."
  }
}

variable "assets_fn_reserved_concurrency" {
  description = "Reserved concurrency for assets-fn. -1 = unreserved (the safe default on small accounts — see the CKV_AWS_115 note in assets.tf). Set a small positive cap after a Service-Quotas raise for defence-in-depth."
  type        = number
  default     = -1
}
