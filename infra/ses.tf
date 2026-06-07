# SESv2 domain identity with EasyDKIM, a custom MAIL FROM subdomain (so SPF
# aligns with the visible From:), and a configuration set streaming send/bounce
# events to CloudWatch (feeds the bounce-rate alarm). Off by default.
#
# The Google/Yahoo/Microsoft 2026 bulk-sender rules require DKIM + aligned SPF +
# DMARC. EasyDKIM yields exactly three CNAMEs; the DMARC TXT record is left for
# you to publish (start p=none, tighten to p=quarantine once clean) — emitted in
# outputs.tf alongside the DKIM/MAIL FROM records.

resource "aws_sesv2_email_identity" "main" {
  count          = var.enable_ses ? 1 : 0
  email_identity = var.ses_domain
}

resource "aws_sesv2_email_identity_mail_from_attributes" "main" {
  count                  = var.enable_ses ? 1 : 0
  email_identity         = aws_sesv2_email_identity.main[0].email_identity
  mail_from_domain       = "mail.${var.ses_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_sesv2_configuration_set" "main" {
  count                  = var.enable_ses ? 1 : 0
  configuration_set_name = "${local.name_prefix}-transactional"

  reputation_options {
    reputation_metrics_enabled = true
  }

  delivery_options {
    tls_policy = "REQUIRE"
  }
}

resource "aws_sesv2_configuration_set_event_destination" "cloudwatch" {
  count                  = var.enable_ses ? 1 : 0
  configuration_set_name = aws_sesv2_configuration_set.main[0].configuration_set_name
  event_destination_name = "cloudwatch"

  event_destination {
    enabled              = true
    matching_event_types = ["SEND", "BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"]

    cloud_watch_destination {
      dimension_configuration {
        dimension_name          = "ses:configuration-set"
        dimension_value_source  = "MESSAGE_TAG"
        default_dimension_value = "${local.name_prefix}-transactional"
      }
    }
  }
}

# DKIM CNAMEs in Route 53 when this stack owns DNS. EasyDKIM always returns 3
# tokens, so count is statically known (for_each over the computed token set
# would be unknown at plan time).
resource "aws_route53_record" "ses_dkim" {
  count   = var.enable_ses && var.enable_dns ? 3 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = "${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.ses_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# MAIL FROM subdomain MX + SPF in Route 53 when this stack owns DNS.
resource "aws_route53_record" "ses_mail_from_mx" {
  count   = var.enable_ses && var.enable_dns ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.main[0].mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count   = var.enable_ses && var.enable_dns ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.main[0].mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}
