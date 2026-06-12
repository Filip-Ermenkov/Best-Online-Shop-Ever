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

  # Decrypt the SecureString + CMK-encrypted log/env data when a CMK is in use.
  # Publishing to the CMK-encrypted email queue additionally needs
  # kms:GenerateDataKey (SQS SSE-KMS encrypts with a data key per batch).
  dynamic "statement" {
    for_each = var.enable_kms_cmk ? [1] : []
    content {
      sid       = "DecryptWithCmk"
      effect    = "Allow"
      actions   = concat(["kms:Decrypt"], var.enable_email_queue ? ["kms:GenerateDataKey"] : [])
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.name_prefix}-shop-api"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# X-Ray write access — only when active tracing is enabled (infra-level
# down-payment on the ADOT roadmap item). X-Ray actions are not resource-scoped.
resource "aws_iam_role_policy_attachment" "lambda_xray" {
  count      = var.enable_xray_tracing ? 1 : 0
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}
