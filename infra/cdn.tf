# CloudFront in front of the shop-api Lambda Function URL.
#
# Security model: Origin Access Control signs every origin request with sigv4,
# and the Function URL is AWS_IAM-only (lambda.tf), so the origin can ONLY be
# reached through this distribution — never directly. The WAF web ACL (waf.tf)
# attaches here when enabled. With no api_domain_name the distribution serves on
# its default *.cloudfront.net domain, so a first deploy needs no DNS or cert.

# An API must not cache by default and must forward the full viewer request
# (minus Host, which CloudFront rewrites to the signed origin host).
data "aws_cloudfront_cache_policy" "caching_disabled" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

# Adds HSTS + X-Content-Type-Options + Referrer-Policy etc. at the edge. The
# frontend proxy already sets the strict CSP on HTML; this hardens API responses.
data "aws_cloudfront_response_headers_policy" "security_headers" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "api" {
  count                             = var.enable_cdn ? 1 : 0
  name                              = "${local.name_prefix}-shop-api"
  description                       = "OAC for the shop-api Lambda Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ACM certificate — CloudFront requires it in us-east-1. Only with a custom domain.
resource "aws_acm_certificate" "api" {
  count             = local.api_has_custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Cert DNS-validation records — only when this stack also manages the zone.
resource "aws_route53_record" "api_cert_validation" {
  for_each = local.api_has_custom_domain && var.enable_dns ? {
    for dvo in aws_acm_certificate.api[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = aws_route53_zone.main[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count                   = local.api_has_custom_domain && var.enable_dns ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for r in aws_route53_record.api_cert_validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "api" {
  count           = var.enable_cdn ? 1 : 0
  enabled         = true
  comment         = "${local.name_prefix} shop-api"
  price_class     = var.cloudfront_price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true
  web_acl_id      = var.enable_waf ? aws_wafv2_web_acl.cdn[0].arn : null
  aliases         = local.api_has_custom_domain ? [var.api_domain_name] : []

  origin {
    domain_name              = trimsuffix(trimprefix(aws_lambda_function_url.shop_api.function_url, "https://"), "/")
    origin_id                = "lambda-shop-api"
    origin_access_control_id = aws_cloudfront_origin_access_control.api[0].id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "lambda-shop-api"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers[0].id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.api_has_custom_domain ? null : true
    acm_certificate_arn            = local.api_has_custom_domain ? aws_acm_certificate.api[0].arn : null
    ssl_support_method             = local.api_has_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.api_has_custom_domain ? "TLSv1.2_2021" : null
  }

  depends_on = [aws_acm_certificate_validation.api]
}

# Allow ONLY this distribution to invoke the Function URL (OAC + sigv4).
resource "aws_lambda_permission" "cloudfront_invoke_url" {
  count                  = var.enable_cdn ? 1 : 0
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.shop_api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.api[0].arn
  function_url_auth_type = "AWS_IAM"
}

# Since October 2025 AWS also requires lambda:InvokeFunction (in addition to
# lambda:InvokeFunctionUrl) for CloudFront OAC to invoke a Function URL — without
# it the Function URL returns 403 even when the OAC signature and everything else
# are correct. Scoped to this one distribution via source_arn.
resource "aws_lambda_permission" "cloudfront_invoke_function" {
  count         = var.enable_cdn ? 1 : 0
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.shop_api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.api[0].arn
}
