# assets.tf — the image-upload pipeline (ARCHITECTURE §3.6, §13; roadmap item 46).
#
# "Build once, serve products + categories + banners." A private S3 bucket with
# two prefixes — `pending/` (un-validated upload target) and `uploads/` (served)
# — a CloudFront+OAC distribution that serves ONLY `uploads/` (origin_path), and
# the assets-fn validator Lambda that magic-byte-checks each upload and promotes
# only genuine images. The browser uploads straight to S3 via a presigned POST
# minted by shop-api (routes/admin/uploads.ts), never through Lambda.
#
# Everything is behind `enable_asset_uploads` (default off), like the email-queue
# and scheduler slices. With it off, this file creates nothing and shop-api's
# upload route returns a clean 503.

# ─── Assets bucket ────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "assets" {
  #checkov:skip=CKV_AWS_18:Access logging needs a second logging bucket; this bucket is private, versioned, TLS-only, KMS-encrypted, reachable only via CloudFront OAC — same accepted finding as the catalog-backup + state buckets.
  #checkov:skip=CKV_AWS_144:Single-region (eu-central-1) by GDPR data-residency design — same accepted finding as the other buckets. Catalog images are re-uploadable, not a system of record.
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = "${local.name_prefix}-assets-${data.aws_caller_identity.current.account_id}"
}

# OAC requires "Bucket owner enforced" (ACLs disabled) — the modern default.
resource "aws_s3_bucket_ownership_controls" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.enable_kms_cmk ? "aws:kms" : "AES256"
      kms_master_key_id = var.enable_kms_cmk ? aws_kms_key.main[0].arn : null
    }
    # One bucket-level data key instead of per-object — ~99% fewer KMS calls.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Browser → S3 presigned POST needs CORS. Only POST (the upload) from the
# configured site origins; the GET path is CloudFront, not the bucket, so the
# bucket itself never needs to allow cross-origin GET.
resource "aws_s3_bucket_cors_configuration" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = var.asset_cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }

  lifecycle {
    precondition {
      condition     = length(var.asset_cors_allowed_origins) > 0
      error_message = "enable_asset_uploads=true requires asset_cors_allowed_origins (the storefront/admin origin[s] the browser uploads from) — an empty list makes every presigned POST fail CORS in the browser."
    }
  }
}

# Lifecycle: un-validated uploads in pending/ never linger; old versions age out;
# incomplete multipart uploads are aborted. The uploads/ prefix is durable.
resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id

  rule {
    id     = "expire-pending"
    status = "Enabled"
    filter {
      prefix = "pending/"
    }
    # The validator promotes-and-deletes within seconds; this only sweeps
    # uploads that were started but never validated (abandoned or rejected-by-
    # lifecycle if the function was down).
    expiration {
      days = var.asset_pending_retention_days
    }
  }

  rule {
    id     = "housekeeping"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Bucket policy: deny non-TLS, and allow ONLY this CloudFront distribution (via
# OAC sigv4) to read the served prefix. Nothing can read pending/ through the CDN
# (origin_path) or directly (public access blocked, no other grant).
data "aws_iam_policy_document" "assets" {
  count = var.enable_asset_uploads ? 1 : 0

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.assets[0].arn,
      "${aws_s3_bucket.assets[0].arn}/*",
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

  statement {
    sid       = "AllowCloudFrontReadServedPrefix"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets[0].arn}/uploads/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.assets[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "assets" {
  count      = var.enable_asset_uploads ? 1 : 0
  bucket     = aws_s3_bucket.assets[0].id
  policy     = data.aws_iam_policy_document.assets[0].json
  depends_on = [aws_s3_bucket_public_access_block.assets]
}

# ─── CloudFront (serves uploads/ only) ────────────────────────────────────────

data "aws_cloudfront_cache_policy" "assets_caching_optimized" {
  count = var.enable_asset_uploads ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "assets_security" {
  count = var.enable_asset_uploads ? 1 : 0
  name  = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "assets" {
  count                             = var.enable_asset_uploads ? 1 : 0
  name                              = "${local.name_prefix}-assets"
  description                       = "OAC for the catalog-assets S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "assets" {
  #checkov:skip=CKV_AWS_68:WAF is opt-in for the API; the assets distribution serves only public, validated catalog images (no auth, no PII) so a WAF earns nothing here.
  #checkov:skip=CKV_AWS_86:Access logging needs a log bucket; same accepted-finding posture as the API distribution. CloudFront/S3 request metrics cover the operational need.
  #checkov:skip=CKV2_AWS_47:Log4Shell WAF rule is moot without a WAF (see CKV_AWS_68) — there is no app server behind this origin, only static S3 objects.
  count           = var.enable_asset_uploads ? 1 : 0
  enabled         = true
  comment         = "${local.name_prefix} catalog assets"
  price_class     = var.cloudfront_price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.assets[0].bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets[0].id
    # Serve ONLY validated objects: every viewer request is prefixed with
    # /uploads, so pending/ is unreachable through the CDN even by exact key.
    origin_path = "/uploads"
  }

  default_cache_behavior {
    target_origin_id           = "s3-assets"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.assets_caching_optimized[0].id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.assets_security[0].id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# ─── assets-fn validator Lambda ───────────────────────────────────────────────
# Mirror of email-fn: a small, single-purpose, least-privilege function. It can
# read pending/, write uploads/, delete pending/, and nothing else — no DB, no
# SSM, no customer data. Built by `npm --workspace @shop/api run build:assets`.

resource "aws_cloudwatch_log_group" "assets_fn" {
  count             = var.enable_asset_uploads ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-assets-fn"
  retention_in_days = var.lambda_log_retention_days
  kms_key_id        = local.kms_key_arn
}

data "archive_file" "assets_fn" {
  count       = var.enable_asset_uploads ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/${var.assets_fn_bundle_dir}"
  output_path = "${path.module}/.artifacts/assets-fn.zip"
}

resource "aws_iam_role" "assets_fn" {
  count              = var.enable_asset_uploads ? 1 : 0
  name               = "${local.name_prefix}-assets-fn"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "assets_fn" {
  count = var.enable_asset_uploads ? 1 : 0

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.assets_fn[0].arn}:*"]
  }

  # Read the pending object (the magic-byte head + the CopyObject source).
  statement {
    sid       = "ReadPending"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets[0].arn}/pending/*"]
  }

  # Write the promoted object to the served prefix.
  statement {
    sid       = "WriteServed"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.assets[0].arn}/uploads/*"]
  }

  # Delete the pending object after promote, or on rejection.
  statement {
    sid       = "DeletePending"
    effect    = "Allow"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.assets[0].arn}/pending/*"]
  }

  # SSE-KMS: decrypt the source object's data key, generate one for the dest.
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

resource "aws_iam_role_policy" "assets_fn" {
  count  = var.enable_asset_uploads ? 1 : 0
  name   = "${local.name_prefix}-assets-fn"
  role   = aws_iam_role.assets_fn[0].id
  policy = data.aws_iam_policy_document.assets_fn[0].json
}

resource "aws_iam_role_policy_attachment" "assets_fn_xray" {
  count      = var.enable_asset_uploads && var.enable_xray_tracing ? 1 : 0
  role       = aws_iam_role.assets_fn[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_lambda_function" "assets_fn" {
  #checkov:skip=CKV_AWS_115:Deliberately UNRESERVED — reserving draws from the account-wide pool (shop-api already reserves 50) and fails the apply on small accounts. The only invoker is the bucket's ObjectCreated notification on a hand-curated admin upload, so the natural invocation rate is tiny; set assets_fn_reserved_concurrency after a quota raise if defence-in-depth is wanted.
  #checkov:skip=CKV_AWS_116:No DLQ by design — the validator is idempotent and self-cleaning: a rejected object is DELETED (so it cannot re-trigger), and a transient S3 fault is retried by the async invoke. Persistent failure surfaces on the assets-fn Errors alarm below; there is no payload worth parking.
  count         = var.enable_asset_uploads ? 1 : 0
  function_name = "${local.name_prefix}-assets-fn"
  description   = "Validates browser-uploaded images by magic bytes and promotes genuine ones to the served prefix (roadmap item 46)."
  role          = aws_iam_role.assets_fn[0].arn
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]
  handler       = "handler.handler"
  memory_size   = 256 # one ranged GET + a copy/delete per object
  timeout       = 30

  reserved_concurrent_executions = var.assets_fn_reserved_concurrency

  filename         = data.archive_file.assets_fn[0].output_path
  source_code_hash = data.archive_file.assets_fn[0].output_base64sha256

  kms_key_arn = local.kms_key_arn

  environment {
    variables = {
      NODE_ENV = "production"
    }
  }

  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = "Active"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.assets_fn,
    aws_iam_role_policy.assets_fn,
  ]
}

# Let S3 invoke the function, scoped to this bucket only.
resource "aws_lambda_permission" "assets_fn_s3" {
  count         = var.enable_asset_uploads ? 1 : 0
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.assets_fn[0].function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.assets[0].arn
}

# Fire the validator on every object created under pending/.
resource "aws_s3_bucket_notification" "assets" {
  count  = var.enable_asset_uploads ? 1 : 0
  bucket = aws_s3_bucket.assets[0].id

  lambda_function {
    lambda_function_arn = aws_lambda_function.assets_fn[0].arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "pending/"
  }

  depends_on = [aws_lambda_permission.assets_fn_s3]
}

# assets-fn errors — a validation invoke threw (S3 fault, a bug). The bucket
# invokes async, so in-function failures only surface on the Lambda Errors
# metric. Mirrors the scheduler-fn-errors alarm (observability.tf 4a).
resource "aws_cloudwatch_metric_alarm" "assets_fn_errors" {
  count               = var.enable_asset_uploads ? 1 : 0
  alarm_name          = "${local.name_prefix}-assets-fn-errors"
  alarm_description   = "The image validator (assets-fn) threw — check its log group for the asset_rejected/promote path and any S3 error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.assets_fn[0].function_name }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
