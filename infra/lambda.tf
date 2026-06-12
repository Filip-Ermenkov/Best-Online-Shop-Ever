variable "enable_xray_tracing" {
  description = "Enable Lambda active X-Ray tracing — the infra-level first step toward the ADOT roadmap item. App-level OTel spans remain that item's work."
  type        = bool
  default     = true
}

variable "lambda_reserved_concurrency" {
  description = "Reserved concurrent executions for shop-api. Caps blast radius (runaway cost) and protects the Neon connection ceiling. -1 = unreserved."
  type        = number
  default     = 50
}

# Pre-created so we own retention + encryption. Lambda would otherwise lazily
# create this group on first invoke with never-expire retention.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name_prefix}-shop-api"
  retention_in_days = var.lambda_log_retention_days
  kms_key_id        = local.kms_key_arn
}

# Zips the esbuild output. Run `npm run build:lambda` in backend/shop-api BEFORE
# `terraform apply`; the hash below tracks the artifact so code changes redeploy.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/${var.lambda_bundle_dir}"
  output_path = "${path.module}/.artifacts/shop-api.zip"
}

resource "aws_lambda_function" "shop_api" {
  function_name = "${local.name_prefix}-shop-api"
  description   = "Customer-facing Hono API (catalog, auth, cart, orders, GDPR, consent)."
  role          = aws_iam_role.lambda.arn
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]
  handler       = "handler.handler"
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_s

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  # CMK-encrypt environment variables (also satisfies the "encrypt env vars"
  # control); null when enable_kms_cmk = false → AWS-managed key.
  kms_key_arn = local.kms_key_arn

  environment {
    variables = {
      NODE_ENV     = "production"
      DATABASE_URL = data.aws_ssm_parameter.database_url.value

      CORS_ORIGINS        = var.cors_origins
      CDN_BASE_URL        = var.cdn_base_url
      LOG_LEVEL           = var.log_level
      PUBLIC_APP_BASE_URL = var.public_app_base_url

      EMAIL_TRANSPORT         = var.email_transport
      EMAIL_FROM              = var.email_from
      EMAIL_AWS_REGION        = var.aws_region
      EMAIL_CONFIGURATION_SET = var.enable_ses ? aws_sesv2_configuration_set.main[0].configuration_set_name : ""
      EMAIL_QUEUE_URL         = var.enable_email_queue ? aws_sqs_queue.email[0].url : ""
    }
  }

  lifecycle {
    precondition {
      condition     = var.email_transport != "sqs" || var.enable_email_queue
      error_message = "email_transport=sqs requires enable_email_queue=true (the queue and email-fn consumer must exist)."
    }
  }

  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = "Active"
    }
  }

  # The log group must exist first, and the inline policy must be attached before
  # the function can write logs.
  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

# Function URL. When the CDN is enabled (default), auth is AWS_IAM so ONLY the
# CloudFront distribution (via OAC + sigv4) can invoke it — the URL is not
# publicly reachable. enable_cdn = false flips it to NONE (direct public access);
# that is an explicit, discouraged no-edge escape hatch.
#checkov:skip=CKV_AWS_258:NONE only applies on the non-default enable_cdn=false escape hatch; the default path is AWS_IAM behind CloudFront OAC.
resource "aws_lambda_function_url" "shop_api" {
  function_name      = aws_lambda_function.shop_api.function_name
  authorization_type = var.enable_cdn ? "AWS_IAM" : "NONE"

  cors {
    allow_origins = var.cors_origins == "" ? ["*"] : split(",", var.cors_origins)
    # Lambda Function URL CORS accepts only GET/HEAD/POST/PUT/PATCH/DELETE/* (each
    # ≤6 chars). OPTIONS is NOT valid here — the Function URL answers preflight
    # automatically. (Note: the CloudFront distribution's allowed_methods is a
    # separate field that DOES include OPTIONS; only this Function-URL list excludes it.)
    allow_methods = ["GET", "POST", "PATCH", "DELETE"]
    allow_headers = ["content-type", "authorization", "idempotency-key", "x-request-id"]
    # Credentials + wildcard origin is an invalid CORS combination, so only send
    # credentials once an explicit origin allowlist is configured.
    allow_credentials = var.cors_origins != ""
    max_age           = 600
  }
}
