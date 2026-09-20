# ─────────────────────────────────────────────────────────────────────────────
# Frontend — Next.js 16 via OpenNext on Lambda + S3 + CloudFront (roadmap item 17)
#
# Supersedes amplify.tf: AWS Amplify Hosting supports Next.js only up through 15,
# and this frontend is Next.js 16. OpenNext builds the app into a server Lambda +
# static assets + an image-optimisation function, and this community module wires
# the CloudFront distribution over them — keeping the whole frontend in Terraform
# so the fmt/validate/tflint/checkov gate still covers it. See ARCHITECTURE §13.
#
# Off by default (enable_frontend = false) so existing applies are unaffected.
#
# PREREQUISITES before `terraform apply` with enable_frontend = true:
#
#   1. Build OpenNext in the frontend workspace — produces frontend/.open-next,
#      which the module reads (open-next.output.json). Use an @opennextjs/aws
#      version that supports Next.js 16:
#        cd frontend
#        NEXT_PUBLIC_SHOP_API_URL=https://shop-api.duda1.shop \
#        NEXT_PUBLIC_SITE_URL=https://duda1.shop \
#        NEXT_PUBLIC_ASSET_S3_ORIGIN=https://<assets_bucket>.s3.eu-central-1.amazonaws.com \
#        NEXT_PUBLIC_ASSET_CDN_ORIGIN=https://<assets_cdn>.cloudfront.net \
#        npx open-next@latest build
#
#   2. bash + the AWS CLI must be on PATH — the module runs helper scripts to
#      upload assets and mutate CloudFront outside Terraform, using the same AWS
#      credentials as the default provider.
#
#   3. The CloudFront cert is DNS-validated, and DNS lives in Cloudflare (not
#      Route53), so validate it out-of-band in two steps (the same pattern the
#      API cert in cdn.tf uses when enable_dns = false):
#        a. terraform apply -target=aws_acm_certificate.frontend
#        b. add the CNAME from `terraform output frontend_cert_validation_record`
#           in Cloudflare (DNS-only / grey cloud); wait until ACM shows "Issued"
#        c. terraform apply     # creates the OpenNext module + distribution
#      Then add a CNAME  duda1.shop → <the module's CloudFront domain>  in
#      Cloudflare (apex CNAME-flattening, DNS-only). The distribution domain is in
#      the module outputs / AWS console after step (c).
# ─────────────────────────────────────────────────────────────────────────────

# CloudFront requires the cert in us-east-1 (the aws.us_east_1 alias in providers.tf).
resource "aws_acm_certificate" "frontend" {
  count             = var.enable_frontend ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.frontend_domain_name
  validation_method = "DNS"

  subject_alternative_names = var.frontend_include_www ? ["www.${var.frontend_domain_name}"] : []

  lifecycle {
    create_before_destroy = true
  }
}

module "frontend" {
  count = var.enable_frontend ? 1 : 0

  # Module source pinned to the v3.7.1 commit SHA (not a registry version range)
  # so it is immutable — satisfies Checkov CKV_TF_1 and matches this repo's
  # SHA-pinning supply-chain posture (cf. the commit-pinned GitHub Actions). No
  # `version` argument — that is only valid for a registry source. Bump both the
  # tag comment and the ?ref= SHA together when upgrading.
  source = "git::https://github.com/RJPearson94/terraform-aws-open-next.git//modules/tf-aws-open-next-zone?ref=84d4adc00ab0ef4d7931357ca3a76e2c7ae28dc5"

  prefix            = "${local.name_prefix}-frontend"
  folder_path       = "${path.root}/../frontend/.open-next"
  open_next_version = "v3.x.x"

  # DNS is managed in Cloudflare, so the module must NOT create Route53 records —
  # it only needs the zone name (to set the CloudFront alias) and the us-east-1
  # ACM cert ARN. We add the duda1.shop CNAME in Cloudflare by hand (see header).
  domain_config = {
    create_route53_entries = false
    include_www            = var.frontend_include_www
    hosted_zones           = [{ name = var.frontend_domain_name }]
    viewer_certificate = {
      acm_certificate_arn = aws_acm_certificate.frontend[0].arn
    }
  }

  # The module runs components across regions via aliased providers. CloudFront,
  # ACM, and the Lambda@Edge functions (edge / auth) MUST live in us-east-1
  # (aws.global → the aws.us_east_1 alias in providers.tf); the server / image /
  # revalidation Lambdas and IAM run in our default region (eu-central-1). DNS is
  # unused here (create_route53_entries = false) but the alias is still required.
  providers = {
    aws                 = aws
    aws.server_function = aws
    aws.iam             = aws
    aws.dns             = aws
    aws.global          = aws.us_east_1
  }
}
