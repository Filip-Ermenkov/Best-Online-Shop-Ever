# GitHub Actions OIDC: CI assumes a least-privilege AWS role with NO long-lived
# access keys. Trust is scoped to this repo + release ref via the `sub` claim and
# the AWS STS audience; the OIDC provider thumbprint is derived at plan time so a
# rotated GitHub cert never breaks the config.

data "tls_certificate" "github_oidc" {
  count = var.enable_github_oidc ? 1 : 0
  url   = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.enable_github_oidc ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_oidc[0].certificates[0].sha1_fingerprint]
}

data "aws_iam_policy_document" "github_assume" {
  count = var.enable_github_oidc ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_sub]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count              = var.enable_github_oidc ? 1 : 0
  name               = "${local.name_prefix}-github-deploy"
  description        = "Assumed by GitHub Actions (OIDC) to ship shop-api Lambda code."
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
}

# Deploy permissions: push the Lambda's code/config and read its state. This is a
# CODE-deploy role (the `aws lambda update-function-code` path in ARCHITECTURE
# §3.12), deliberately NOT a full terraform-apply admin role — that broader role
# is created consciously by the owner, not handed to CI by default.
data "aws_iam_policy_document" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0

  statement {
    sid    = "UpdateAppLambdas"
    effect = "Allow"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:PublishVersion",
    ]
    # shop-api always; email-fn / scheduler-fn when their features are enabled
    # (splat → empty list when count = 0, so the policy stays valid either way).
    resources = concat(
      [aws_lambda_function.shop_api.arn],
      aws_lambda_function.email_fn[*].arn,
      aws_lambda_function.scheduler_fn[*].arn,
    )
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = var.enable_github_oidc ? 1 : 0
  name   = "${local.name_prefix}-github-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
