# Route 53 hosted zone + the API alias records. Off by default — the §10 cost
# model prefers Cloudflare for DNS (free, stronger DDoS). Enable only to keep DNS
# inside AWS. When off, publish the records emitted in outputs.tf at your DNS host.
resource "aws_route53_zone" "main" {
  count = var.enable_dns ? 1 : 0
  name  = var.root_domain_name
}

resource "aws_route53_record" "api_alias_a" {
  count   = var.enable_dns && local.api_has_custom_domain ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = var.api_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.api[0].domain_name
    zone_id                = aws_cloudfront_distribution.api[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_alias_aaaa" {
  count   = var.enable_dns && local.api_has_custom_domain ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = var.api_domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.api[0].domain_name
    zone_id                = aws_cloudfront_distribution.api[0].hosted_zone_id
    evaluate_target_health = false
  }
}
