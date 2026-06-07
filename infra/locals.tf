locals {
  name_prefix = "${var.project}-${var.environment}"

  common_tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "${var.github_owner}/${var.github_repo}"
    },
    var.tags,
  )

  # Systems Manager Parameter Store path (Standard tier, free).
  # Only genuine secrets live here; non-secret config is passed as plain Lambda
  # environment variables. Today that is exactly one parameter: the Neon URL.
  ssm_prefix         = "/${local.name_prefix}"
  database_url_param = "${local.ssm_prefix}/DATABASE_URL"

  # The GitHub OIDC `sub` claim the deploy role is allowed to assume from.
  # Scoped to a single ref so only main-branch (or the configured ref) runs can
  # deploy. Example: repo:Filip-Ermenkov/Best-Online-Shop-Ever:ref:refs/heads/main
  github_oidc_sub = "repo:${var.github_owner}/${var.github_repo}:ref:${var.github_deploy_ref}"

  # CloudFront in front of the API needs an ACM cert + (optionally) a custom
  # domain alias. Both only make sense when a domain is supplied.
  api_has_custom_domain = var.enable_cdn && var.api_domain_name != ""

  # Public base URL the frontend uses to reach the API: custom domain if set,
  # else the CloudFront default domain, else the raw Function URL (no-edge mode).
  # Splat + one() avoids indexing a count=0 resource.
  api_public_url = coalesce(
    local.api_has_custom_domain ? "https://${var.api_domain_name}" : null,
    var.enable_cdn ? "https://${one(aws_cloudfront_distribution.api[*].domain_name)}" : null,
    aws_lambda_function_url.shop_api.function_url,
  )
}
