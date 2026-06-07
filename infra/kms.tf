# Customer-managed KMS key for the Lambda log group and the DATABASE_URL secret.
#
# Why a CMK: CloudWatch Logs cannot encrypt a log group with an AWS-managed key
# (it specifically requires a customer-managed key), and a CMK on the secret
# means the *key policy* — not IAM alone — gates who can decrypt the Neon URL.
#
# Cost: ~$1/mo for the key + negligible per-request usage. Set
# enable_kms_cmk = false to fall back to AWS-managed keys and keep the documented
# €0 tier; data is still encrypted at rest, just with an AWS-owned/managed key.

variable "enable_kms_cmk" {
  description = "Customer-managed KMS key for the log group + DATABASE_URL secret (~$1/mo). false = AWS-managed keys (still encrypted, €0)."
  type        = bool
  default     = true
}

resource "aws_kms_key" "main" {
  count                   = var.enable_kms_cmk ? 1 : 0
  description             = "${local.name_prefix} — logs + secrets encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  # Least-privilege key policy: root for break-glass admin, plus a narrowly
  # scoped grant for the regional CloudWatch Logs service principal.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootAccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name_prefix}-shop-api"
          }
        }
      },
      {
        # Lets CloudWatch alarms publish to the KMS-encrypted alarms SNS topic.
        Sid       = "AllowCloudWatchAndSnsUseOfKey"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "sns.amazonaws.com"] }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  count         = var.enable_kms_cmk ? 1 : 0
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.main[0].key_id
}

locals {
  kms_key_arn    = var.enable_kms_cmk ? aws_kms_key.main[0].arn : null
  ssm_kms_key_id = var.enable_kms_cmk ? aws_kms_key.main[0].key_id : "alias/aws/ssm"
  # CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed
  # alias/aws/sns key (its policy can't grant cloudwatch.amazonaws.com). So the
  # CMK is required for working encrypted alarm notifications; the AWS-managed
  # key is only the €0 fallback (documented limitation).
  sns_kms_key_id = var.enable_kms_cmk ? aws_kms_key.main[0].key_id : "alias/aws/sns"
}
