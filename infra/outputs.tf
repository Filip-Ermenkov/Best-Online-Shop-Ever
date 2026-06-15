output "lambda_function_name" {
  description = "shop-api Lambda function name (use as the target of aws lambda update-function-code in CI)."
  value       = aws_lambda_function.shop_api.function_name
}

output "lambda_function_arn" {
  description = "shop-api Lambda ARN."
  value       = aws_lambda_function.shop_api.arn
}

output "lambda_function_url" {
  description = "Raw Lambda Function URL. AWS_IAM-protected when the CDN is enabled (reachable only via CloudFront)."
  value       = aws_lambda_function_url.shop_api.function_url
}

output "api_public_url" {
  description = "The URL the frontend should call (custom domain → CloudFront → Function URL, in that order of preference)."
  value       = local.api_public_url
}

output "cloudfront_distribution_id" {
  description = "API CloudFront distribution id (for cache invalidations), or null when the CDN is disabled."
  value       = one(aws_cloudfront_distribution.api[*].id)
}

output "cloudfront_domain_name" {
  description = "API CloudFront default domain (*.cloudfront.net), or null when the CDN is disabled."
  value       = one(aws_cloudfront_distribution.api[*].domain_name)
}

output "github_deploy_role_arn" {
  description = "ARN GitHub Actions assumes via OIDC (set as the AWS_DEPLOY_ROLE_ARN repo variable)."
  value       = one(aws_iam_role.github_deploy[*].arn)
}

output "database_url_param_name" {
  description = "SSM SecureString parameter to populate with the real Neon URL after the first apply."
  value       = aws_ssm_parameter.database_url.name
}

output "kms_key_arn" {
  description = "Customer-managed KMS key ARN (null when enable_kms_cmk = false)."
  value       = local.kms_key_arn
}

output "alarms_topic_arn" {
  description = "SNS topic that all CloudWatch alarms publish to."
  value       = aws_sns_topic.alarms.arn
}

output "slo_alarm_names" {
  description = "SLO burn-rate alarm names that notify (composites + latency), or [] when enable_slo_alarms = false. Objective contract: infra/slos.yaml."
  value = var.enable_slo_alarms ? [
    one(aws_cloudwatch_composite_alarm.slo_availability_fast[*].alarm_name),
    one(aws_cloudwatch_composite_alarm.slo_availability_slow[*].alarm_name),
    one(aws_cloudwatch_composite_alarm.slo_orders_fast[*].alarm_name),
    one(aws_cloudwatch_metric_alarm.slo_latency_p95[*].alarm_name),
  ] : []
}

output "email_queue_url" {
  description = "Durable email queue URL (shop-api's EMAIL_QUEUE_URL — wired automatically), or null when enable_email_queue = false."
  value       = one(aws_sqs_queue.email[*].url)
}

output "email_dlq_url" {
  description = "Email dead-letter queue URL (inspect + redrive here when the email-dlq-depth alarm fires), or null when enable_email_queue = false."
  value       = one(aws_sqs_queue.email_dlq[*].url)
}

output "catalog_backup_bucket" {
  description = "S3 bucket the daily catalog backup writes to (catalog/<YYYY-MM-DD>.json, Sofia dates), or null when enable_scheduler = false."
  value       = one(aws_s3_bucket.catalog_backup[*].bucket)
}

output "scheduler_dlq_url" {
  description = "EventBridge Scheduler delivery DLQ URL (inspect here when the scheduler-delivery-failures alarm fires), or null when enable_scheduler = false."
  value       = one(aws_sqs_queue.scheduler_dlq[*].url)
}

output "amplify_app_id" {
  description = "Amplify app id (null when Amplify is disabled)."
  value       = one(aws_amplify_app.frontend[*].id)
}

output "amplify_default_domain" {
  description = "Amplify default domain (null when Amplify is disabled)."
  value       = one(aws_amplify_app.frontend[*].default_domain)
}

output "route53_name_servers" {
  description = "Hosted-zone name servers to delegate to at the registrar (empty when DNS is not managed here)."
  value       = try(aws_route53_zone.main[0].name_servers, [])
}

# ─── SES DNS records to publish when DNS is NOT managed in Route 53 ───────────
# (When enable_dns = true these are created automatically; see ses.tf.)

output "ses_dkim_cname_records" {
  description = "Three DKIM CNAMEs to publish for SES (name → value). Empty when SES is disabled."
  value = var.enable_ses ? {
    for token in aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens :
    "${token}._domainkey.${var.ses_domain}" => "${token}.dkim.amazonses.com"
  } : {}
}

output "ses_mail_from_domain" {
  description = "Custom MAIL FROM subdomain (needs an MX → feedback-smtp.<region>.amazonses.com and an SPF TXT)."
  value       = one(aws_sesv2_email_identity_mail_from_attributes.main[*].mail_from_domain)
}

output "dmarc_record_hint" {
  description = "Suggested initial DMARC TXT record to publish at _dmarc.<domain> (start at p=none, tighten later)."
  value       = var.enable_ses ? "_dmarc.${var.ses_domain} TXT \"v=DMARC1; p=none; rua=mailto:dmarc@${var.ses_domain}\"" : ""
}
