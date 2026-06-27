# shop-api Lambda execution role — least privilege, no managed admin policies.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_prefix}-shop-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  # Write logs to the function's own log group only. The group is pre-created in
  # lambda.tf, so logs:CreateLogGroup is intentionally NOT granted.
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  # Read exactly one runtime secret: the Neon connection string.
  statement {
    sid       = "ReadDatabaseUrl"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [aws_ssm_parameter.database_url.arn]
  }

  # Send transactional email, scoped to this account's SES identities + config
  # sets in this region (SES SendEmail does not support tighter resource ARNs
  # than the identity).
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

  # Enqueue rendered emails onto the durable email queue (EMAIL_TRANSPORT=sqs).
  dynamic "statement" {
    for_each = var.enable_email_queue ? [1] : []
    content {
      sid       = "EnqueueEmail"
      effect    = "Allow"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.email[0].arn]
    }
  }

  # Image uploads (roadmap item 46). The browser uploads with shop-api's
  # presigned-POST signature, so this role must be able to PutObject the
  # server-chosen pending key — scoped to pending/* only, never the served
  # prefix. Separately, the upload-status poll HEADs the promoted object, which
  # needs s3:GetObject on uploads/*.
  dynamic "statement" {
    for_each = var.enable_asset_uploads ? [1] : []
    content {
      sid       = "SignAssetUploads"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.assets[0].arn}/pending/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_asset_uploads ? [1] : []
    content {
      sid       = "HeadServedAsset"
      effect    = "Allow"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.assets[0].arn}/uploads/*"]
    }
  }

  # Decrypt the SecureString + CMK-encrypted log/env data when a CMK is in use.
  # Publishing to the CMK-encrypted email queue, OR writing the CMK-encrypted
  # asset bucket via the presigned POST, additionally needs kms:GenerateDataKey
  # (SSE-KMS encrypts with a per-object/per-batch data key).
  dynamic "statement" {
    for_each = var.enable_kms_cmk ? [1] : []
    content {
      sid       = "DecryptWithCmk"
      effect    = "Allow"
      actions   = concat(["kms:Decrypt"], (var.enable_email_queue || var.enable_asset_uploads) ? ["kms:GenerateDataKey"] : [])
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.name_prefix}-shop-api"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# X-Ray write access — when active tracing is enabled. Covers BOTH the Lambda
# Active-tracing root segment AND (when enable_tracing=true) the ADOT collector
# layer's awsxray exporter: AWSXRayDaemonWriteAccess grants xray:PutTraceSegments
# + the sampling APIs the collector calls. The lambda.tf precondition ties
# enable_tracing → enable_xray_tracing so this attachment is always present when
# the app emits spans. X-Ray actions are not resource-scoped.
resource "aws_iam_role_policy_attachment" "lambda_xray" {
  count      = var.enable_xray_tracing ? 1 : 0
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}
