# scheduler-fn — the background-jobs Lambda + its EventBridge Scheduler
# schedules (ARCHITECTURE §3.8, roadmap item 23). Everything here is behind
# enable_scheduler (default off), same feature-flag discipline as the email
# queue.
#
# Why EventBridge SCHEDULER (not classic EventBridge rules): it is the
# purpose-built 2026 service for cron — IANA-timezone cron expressions with
# DST handled by AWS (the Sofia business jobs run at Sofia wall-clock time
# year-round), per-schedule retry policies, a per-schedule DLQ for DELIVERY
# failures, and dedicated CloudWatch metrics (InvocationsSentToDeadLetterCount
# etc. — see observability.tf).
#
# Failure model (two distinct lanes, two alarms):
#   - DELIVERY failures (throttle, broken IAM): Scheduler retries per
#     retry_policy, then parks the event in the scheduler DLQ →
#     scheduler-delivery-failures alarm.
#   - IN-FUNCTION failures (job threw: DB down, bucket missing): the invoke
#     is ASYNC, so these never reach the Scheduler — Lambda's own async
#     retries (2) run, then the error lands on the Errors metric →
#     scheduler-fn-errors alarm.
#   There is deliberately NO job-level redrive: every job is an idempotent
#   full-scan sweep (claim markers / date-keyed writes), so the next
#   scheduled run IS the redrive. The alarms exist so a *persistently*
#   failing job gets a human.
#
# The function reuses @shop/api's code (src/jobs/*, bundled separately by
# `npm --workspace @shop/api run build:scheduler` → dist-scheduler/). The
# bundle is pure JS (no argon2 — the jobs' import graph avoids session/
# password code), so unlike the shop-api HTTP bundle it builds on any OS.

# ─── Log group ────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "scheduler_fn" {
  count             = var.enable_scheduler ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-scheduler-fn"
  retention_in_days = var.lambda_log_retention_days
  kms_key_id        = local.kms_key_arn
}

# ─── Bundle ───────────────────────────────────────────────────────────────────

data "archive_file" "scheduler_fn" {
  count       = var.enable_scheduler ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/${var.scheduler_fn_bundle_dir}"
  output_path = "${path.module}/.artifacts/scheduler-fn.zip"
}

# ─── Execution role ───────────────────────────────────────────────────────────

resource "aws_iam_role" "scheduler_fn" {
  count              = var.enable_scheduler ? 1 : 0
  name               = "${local.name_prefix}-scheduler-fn"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "scheduler_fn" {
  count = var.enable_scheduler ? 1 : 0

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.scheduler_fn[0].arn}:*"]
  }

  # Same single runtime secret as shop-api: the jobs read/write the same
  # database the API serves.
  statement {
    sid       = "ReadDatabaseUrl"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [aws_ssm_parameter.database_url.arn]
  }

  # The jobs send email (expired-pickup admin notice, day-6 deletion warning)
  # through the SAME transport selection as shop-api: sqs → enqueue (the
  # email-fn consumer owns delivery), ses → direct send. Grant what the
  # configured transports can reach — identical scoping to iam.tf.
  statement {
    sid    = "SendTransactionalEmail"
    effect = "Allow"
    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
      "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:configuration-set/*",
    ]
  }

  dynamic "statement" {
    for_each = var.enable_email_queue ? [1] : []
    content {
      sid       = "EnqueueEmail"
      effect    = "Allow"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.email[0].arn]
    }
  }

  # WRITE-ONLY access to the backup bucket: the job can only add the day's
  # object. No Get/List/Delete — retention is the lifecycle rule's job, and a
  # compromised scheduler-fn cannot read or destroy backup history.
  statement {
    sid       = "WriteCatalogBackup"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.catalog_backup[0].arn}/*"]
  }

  # kms:Decrypt — CMK-encrypted env vars at runtime; kms:GenerateDataKey —
  # publishing to the CMK-encrypted email queue AND SSE-KMS PutObject to the
  # backup bucket.
  dynamic "statement" {
    for_each = var.enable_kms_cmk ? [1] : []
    content {
      sid       = "UseCmk"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "scheduler_fn" {
  count  = var.enable_scheduler ? 1 : 0
  name   = "${local.name_prefix}-scheduler-fn"
  role   = aws_iam_role.scheduler_fn[0].id
  policy = data.aws_iam_policy_document.scheduler_fn[0].json
}

resource "aws_iam_role_policy_attachment" "scheduler_fn_xray" {
  count      = var.enable_scheduler && var.enable_xray_tracing ? 1 : 0
  role       = aws_iam_role.scheduler_fn[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# ─── Function ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "scheduler_fn" {
  #checkov:skip=CKV_AWS_115:Deliberately UNRESERVED — same account-pool rationale as email-fn (a reservation can fail the apply on small accounts). Concurrency is naturally ≤1 per schedule: three crons that each fire one async invoke.
  #checkov:skip=CKV_AWS_116:An async-invoke DLQ would re-run a job whose NEXT scheduled sweep already covers the same work (jobs are idempotent full scans) — the failure signal is the Errors alarm, the redrive is the next cron tick.
  count         = var.enable_scheduler ? 1 : 0
  function_name = "${local.name_prefix}-scheduler-fn"
  description   = "Scheduled jobs: hourly expired-pickup check, daily unverified-account cleanup, daily catalog backup (roadmap item 23)."
  role          = aws_iam_role.scheduler_fn[0].arn
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]
  handler       = "handler.handler"
  memory_size   = 512 # full-catalog JSON in memory during the backup job
  timeout       = 60  # sweeps are seconds; headroom for Neon cold connects

  filename         = data.archive_file.scheduler_fn[0].output_path
  source_code_hash = data.archive_file.scheduler_fn[0].output_base64sha256

  kms_key_arn = local.kms_key_arn

  environment {
    variables = {
      NODE_ENV     = "production"
      DATABASE_URL = data.aws_ssm_parameter.database_url.value
      LOG_LEVEL    = var.log_level

      PUBLIC_APP_BASE_URL = var.public_app_base_url

      EMAIL_TRANSPORT         = var.email_transport
      EMAIL_FROM              = var.email_from
      EMAIL_AWS_REGION        = var.aws_region
      EMAIL_CONFIGURATION_SET = var.enable_ses ? aws_sesv2_configuration_set.main[0].configuration_set_name : ""
      EMAIL_QUEUE_URL         = var.enable_email_queue ? aws_sqs_queue.email[0].url : ""

      CATALOG_BACKUP_BUCKET = aws_s3_bucket.catalog_backup[0].bucket
      CATALOG_BACKUP_PREFIX = "catalog/"
    }
  }

  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = "Active"
    }
  }

  lifecycle {
    precondition {
      condition     = var.email_transport != "sqs" || var.enable_email_queue
      error_message = "email_transport=sqs requires enable_email_queue=true (the queue and email-fn consumer must exist)."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.scheduler_fn,
    aws_iam_role_policy.scheduler_fn,
  ]
}

# ─── Scheduler → Lambda invoke role ──────────────────────────────────────────
# EventBridge Scheduler does not use resource policies; each schedule assumes
# an IAM role to invoke its target. Confused-deputy guarded: only schedules in
# THIS account's jobs group can assume it.

data "aws_iam_policy_document" "scheduler_assume" {
  count = var.enable_scheduler ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    # MUST be the schedule-GROUP arn (…:schedule-group/<name>) — that is the
    # SourceArn EventBridge Scheduler presents when assuming the role.
    # Scoping to schedule/<group>/* fails CreateSchedule with
    # "The execution role you provide must allow AWS EventBridge Scheduler
    # to assume the role" (hit live 2026-06-12; per the AWS confused-deputy
    # guide for Scheduler).
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_scheduler_schedule_group.jobs[0].arn]
    }
  }
}

resource "aws_iam_role" "scheduler_invoke" {
  count              = var.enable_scheduler ? 1 : 0
  name               = "${local.name_prefix}-scheduler-invoke"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume[0].json
}

data "aws_iam_policy_document" "scheduler_invoke" {
  count = var.enable_scheduler ? 1 : 0

  statement {
    sid       = "InvokeSchedulerFn"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.scheduler_fn[0].arn]
  }

  # Delivery-failure parking. The role (not the service) writes to the DLQ,
  # so it needs the queue + the CMK it is encrypted with.
  statement {
    sid       = "DeadLetterParking"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.scheduler_dlq[0].arn]
  }

  dynamic "statement" {
    for_each = var.enable_kms_cmk ? [1] : []
    content {
      sid       = "EncryptDeadLetters"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  count  = var.enable_scheduler ? 1 : 0
  name   = "${local.name_prefix}-scheduler-invoke"
  role   = aws_iam_role.scheduler_invoke[0].id
  policy = data.aws_iam_policy_document.scheduler_invoke[0].json
}

# ─── Delivery DLQ ─────────────────────────────────────────────────────────────
# Catches schedule DELIVERY failures only (in-function failures land on the
# Lambda Errors metric instead — see the header). Payloads are the schedules'
# static inputs ({"job":"…"} + Scheduler metadata) — no personal data — but the
# CMK is applied anyway for uniformity with the email queues.

resource "aws_sqs_queue" "scheduler_dlq" {
  count = var.enable_scheduler ? 1 : 0
  name  = "${local.name_prefix}-scheduler-dlq"

  message_retention_seconds = 1209600 # 14 days to notice and inspect

  kms_master_key_id                 = var.enable_kms_cmk ? aws_kms_key.main[0].key_id : null
  kms_data_key_reuse_period_seconds = var.enable_kms_cmk ? 300 : null
  sqs_managed_sse_enabled           = var.enable_kms_cmk ? null : true
}

# ─── Schedules ────────────────────────────────────────────────────────────────
# Sofia wall-clock crons (ARCHITECTURE §3.8): EventBridge Scheduler handles
# the EET↔EEST transitions, so "03:00 Sofia" stays 03:00 Sofia year-round.
# flexible_time_window is OFF on purpose: the runbooks promise "the backup
# exists by 03:05 Sofia" — determinism beats load-smoothing at this scale.
# Retry policy bounds DELIVERY retries; an event undeliverable for 30 minutes
# parks in the DLQ (the next cron tick supersedes it anyway).

resource "aws_scheduler_schedule_group" "jobs" {
  count = var.enable_scheduler ? 1 : 0
  name  = "${local.name_prefix}-jobs"
}

locals {
  scheduler_jobs = {
    # Hourly, on the hour. Spec §7: notify the admin about expired pickup
    # deadlines; the order itself stays put for a manual decision.
    "pickup-expiry" = {
      schedule_expression = "cron(0 * * * ? *)"
      description         = "Hourly expired-pickup-deadline check → admin email (spec §7)."
    }
    # 03:00 Sofia — catalog backup BEFORE the 04:00 cleanup, so every day has
    # a pre-cleanup snapshot.
    "catalog-backup" = {
      schedule_expression = "cron(0 3 * * ? *)"
      description         = "Daily catalog backup to S3 (ARCHITECTURE §6.3)."
    }
    # 04:00 Sofia — day-6 warning + day-7 deletion of unverified accounts
    # (GDPR Art. 5(1)(e) storage limitation; spec §8).
    "unverified-cleanup" = {
      schedule_expression = "cron(0 4 * * ? *)"
      description         = "Daily unverified-account cleanup: day-6 warning, day-7 hard delete (spec §8)."
    }
  }
}

resource "aws_scheduler_schedule" "jobs" {
  for_each = var.enable_scheduler ? local.scheduler_jobs : {}

  #checkov:skip=CKV_AWS_297:The only data a schedule stores is its static, non-sensitive input — `{"job":"<name>"}`, the same job names that live in this file and in git. No PII, secret, or customer data passes through a schedule, so a customer-managed key would only add key-policy surface (granting scheduler.amazonaws.com decrypt) and apply-risk to the already-validated live schedules for zero confidentiality gain — the same value-based reasoning as the CKV_AWS_116 skip below. Revisit if a schedule ever carries sensitive input.

  name        = "${local.name_prefix}-${each.key}"
  group_name  = aws_scheduler_schedule_group.jobs[0].name
  description = each.value.description
  state       = "ENABLED"

  schedule_expression          = each.value.schedule_expression
  schedule_expression_timezone = "Europe/Sofia"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.scheduler_fn[0].arn
    role_arn = aws_iam_role.scheduler_invoke[0].arn
    input    = jsonencode({ job = each.key })

    retry_policy {
      maximum_event_age_in_seconds = 1800
      maximum_retry_attempts       = 3
    }

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq[0].arn
    }
  }
}

# ─── Catalog-backup bucket ────────────────────────────────────────────────────
# §6.3: daily catalog backup, versioned, 90-day retention, SSE-KMS. The
# content is catalog data only (products/categories/images/banners) — zero
# personal data, so the GDPR backup-erasure tension never applies to this
# bucket. Account id in the name: S3 names are global.

resource "aws_s3_bucket" "catalog_backup" {
  #checkov:skip=CKV_AWS_18:Access logging needs a second logging bucket; this bucket is private, versioned, TLS-only, KMS-encrypted and written by exactly one role — same accepted finding as the state bucket.
  #checkov:skip=CKV_AWS_144:Single-region (eu-central-1) by GDPR data-residency design — same accepted finding as the state bucket.
  #checkov:skip=CKV2_AWS_62:Event notifications have no consumer here; the scheduler-fn-errors alarm already covers "backup did not happen".
  count  = var.enable_scheduler ? 1 : 0
  bucket = "${local.name_prefix}-catalog-backup-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "catalog_backup" {
  count  = var.enable_scheduler ? 1 : 0
  bucket = aws_s3_bucket.catalog_backup[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "catalog_backup" {
  count  = var.enable_scheduler ? 1 : 0
  bucket = aws_s3_bucket.catalog_backup[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.enable_kms_cmk ? "aws:kms" : "AES256"
      kms_master_key_id = var.enable_kms_cmk ? aws_kms_key.main[0].arn : null
    }
    # Bucket key: one data key per bucket-ish instead of per object — cuts
    # KMS request cost by ~99% on SSE-KMS buckets.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "catalog_backup" {
  count  = var.enable_scheduler ? 1 : 0
  bucket = aws_s3_bucket.catalog_backup[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "catalog_backup" {
  count  = var.enable_scheduler ? 1 : 0
  bucket = aws_s3_bucket.catalog_backup[0].id

  rule {
    id     = "retention"
    status = "Enabled"

    filter {} # whole bucket

    # §6.3's 90-day retention for daily snapshots…
    expiration {
      days = var.catalog_backup_retention_days
    }
    # …same-day re-run overwrites age out faster…
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    # …and incomplete uploads never linger.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# TLS-only, like the state bucket: deny any non-HTTPS access outright.
data "aws_iam_policy_document" "catalog_backup" {
  count = var.enable_scheduler ? 1 : 0

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.catalog_backup[0].arn,
      "${aws_s3_bucket.catalog_backup[0].arn}/*",
    ]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "catalog_backup" {
  count  = var.enable_scheduler ? 1 : 0
  bucket = aws_s3_bucket.catalog_backup[0].id
  policy = data.aws_iam_policy_document.catalog_backup[0].json

  depends_on = [aws_s3_bucket_public_access_block.catalog_backup]
}
