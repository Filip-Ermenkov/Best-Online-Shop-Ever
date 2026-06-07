# Two AWS providers.
#
# Default: eu-central-1 (Frankfurt) — the GDPR data-residency region the whole
# project is pinned to (SES, Lambda, logs, everything customer-facing).
#
# us_east_1 alias: CloudFront is a global service whose ACM certificates and
# WAFv2 (scope = CLOUDFRONT) web ACLs MUST live in us-east-1. This alias exists
# purely to create those two edge resources; nothing customer data touches it.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}
