# email-fn — the queue-consumer Lambda for durable email delivery (item 21).
#
# Small, single-purpose deployable: it receives SQS batches of rendered emails
# (the @shop/email queue envelope) and performs the SES send. Built by
# `npm --workspace @shop/email run build:lambda` → backend/email/dist/, zipped
# at plan time like shop-api's bundle. Pure JS — no native-dependency step, so
# unlike shop-api it can be built on any OS.
#
# Failure semantics (the reason this function exists):
#   - The event source mapping enables ReportBatchItemFailures; the consumer
#     returns per-record failures so a bad email never blocks or re-sends the
#     rest of its batch.
#   - Failed records redeliver with visibility-timeout spacing (sqs.tf) and
#     park in the DLQ after max_receive_count attempts → email-dlq-depth alarm.
#   - scaling_config.maximum_concurrency = 2 keeps the SES send rate gentle
#     (well under even sandbox quotas) without a token bucket in code.
#
# Least privilege: this role can consume the email queue and send via SES.
# It has NO database access and NO SSM access — a compromised email-fn cannot
# read the Neon URL or any customer rows.

resource "aws_cloudwatch_log_group" "email_fn" {
  count             = var.enable_email_queue ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-email-fn"
  retention_in_days = var.lambda_log_retention_days
  kms_key_id        = local.kms_key_arn
}

data "archive_file" "email_fn" {
  count       = var.enable_email_queue ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/${var.email_fn_bundle_dir}"
  output_path = "${path.module}/.artifacts/email-fn.zip"
}

resource "aws_iam_role" "email_fn" {
  count              = var.enable_email_queue ? 1 : 0
  name               = "${local.name_prefix}-email-fn"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "email_fn" {
  count = var.enable_email_queue ? 1 : 0

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.email_fn[0].arn}:*"]
  }

  # Consume the email queue. (kms:Decrypt for the CMK-encrypted payloads is
  # granted below; SQS-managed SSE needs no extra permission.)
  statement {
    sid    = "ConsumeEmailQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.email[0].arn]
  }

  # The actual SES send — same identity/config-set scoping as shop-api's
  # statement (SES supports no tighter resource ARN than the identity).
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
    for_each = var.enable_kms_cmk ? [1] : []
    content {
      sid       = "DecryptWithCmk"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "email_fn" {
  count  = var.enable_email_queue ? 1 : 0
  name   = "${local.name_prefix}-email-fn"
  role   = aws_iam_role.email_fn[0].id
  policy = data.aws_iam_policy_document.email_fn[0].json
}

resource "aws_iam_role_policy_attachment" "email_fn_xray" {
  count      = var.enable_email_queue && var.enable_xray_tracing ? 1 : 0
  role       = aws_iam_role.email_fn[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_lambda_function" "email_fn" {
  #checkov:skip=CKV_AWS_115:Deliberately UNRESERVED — reserving here draws from the account-wide pool, and on small/new accounts (shop-api already reserves 50) that pushes unreserved concurrency below AWS's minimum and the apply fails. The binding cap is the event source mapping's maximum_concurrency (2), which throttles SQS-driven invocations WITHOUT consuming the pool; nothing else can invoke this function (no URL, no other triggers). Set email_fn_reserved_concurrency after an account quota raise if defence-in-depth is wanted.
  count         = var.enable_email_queue ? 1 : 0
  function_name = "${local.name_prefix}-email-fn"
  description   = "SQS email-queue consumer — durable SES delivery with retry + DLQ (roadmap item 21)."
  role          = aws_iam_role.email_fn[0].arn
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]
  handler       = "handler.handler"
  memory_size   = 256 # renders nothing; just JSON parse + one SDK call per record
  timeout       = 30  # sqs.tf's visibility_timeout (180s) is 6× this — keep in sync

  # -1 = unreserved (see the checkov-skip rationale above); the ESM's
  # maximum_concurrency (2) is the real throttle either way.
  reserved_concurrent_executions = var.email_fn_reserved_concurrency

  filename         = data.archive_file.email_fn[0].output_path
  source_code_hash = data.archive_file.email_fn[0].output_base64sha256

  kms_key_arn = local.kms_key_arn

  environment {
    variables = {
      NODE_ENV                = "production"
      EMAIL_FROM              = var.email_from
      EMAIL_AWS_REGION        = var.aws_region
      EMAIL_CONFIGURATION_SET = var.enable_ses ? aws_sesv2_configuration_set.main[0].configuration_set_name : ""
    }
  }

  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = "Active"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.email_fn,
    aws_iam_role_policy.email_fn,
  ]
}

resource "aws_lambda_event_source_mapping" "email_fn" {
  count            = var.enable_email_queue ? 1 : 0
  event_source_arn = aws_sqs_queue.email[0].arn
  function_name    = aws_lambda_function.email_fn[0].arn
  batch_size       = 10

  # Partial-batch responses: only failed records redeliver; successfully sent
  # emails in the same batch are deleted and can never be sent twice by a
  # batch-mate's failure.
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}
