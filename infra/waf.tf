# WAFv2 web ACL for the API CloudFront distribution. Scope = CLOUDFRONT, so it
# MUST be created in us-east-1. Off by default: the §10 cost model documents
# Cloudflare's free WAF as the preferred edge. This is the AWS-native path,
# mirroring the managed rule sets named in ARCHITECTURE §3.2.
resource "aws_wafv2_web_acl" "cdn" {
  count    = var.enable_cdn && var.enable_waf ? 1 : 0
  provider = aws.us_east_1
  name     = "${local.name_prefix}-cdn"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Blocks known-bad request patterns including Log4Shell (CVE-2021-44228).
  rule {
    name     = "known-bad-inputs"
    priority = 0
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-known-bad"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "common-rule-set"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "sqli-rule-set"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-sqli"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-cdn"
    sampled_requests_enabled   = true
  }
}
