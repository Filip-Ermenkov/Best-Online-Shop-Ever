# AWS Amplify Hosting for the Next.js 16 frontend (SSR ⇒ platform WEB_COMPUTE).
#
# Off by default. You can also connect the repo directly in the Amplify console,
# which avoids routing a GitHub token through Terraform state. When enabling
# here, pass github_access_token via TF_VAR_github_access_token and set
# amplify_repository_url. NOTE: Amplify does NOT support on-demand revalidation
# (revalidateTag/revalidatePath); only time-based ISR — see ARCHITECTURE §3.3.
resource "aws_amplify_app" "frontend" {
  count        = var.enable_amplify ? 1 : 0
  name         = "${local.name_prefix}-frontend"
  repository   = var.amplify_repository_url
  access_token = var.github_access_token
  platform     = "WEB_COMPUTE"

  environment_variables = {
    NEXT_PUBLIC_SHOP_API_URL = local.api_public_url
    NEXT_PUBLIC_SITE_URL     = var.public_app_base_url
  }

  build_spec = <<-YAML
    version: 1
    applications:
      - appRoot: frontend
        frontend:
          phases:
            preBuild:
              commands:
                - npm ci
            build:
              commands:
                - npm run build
          artifacts:
            baseDirectory: .next
            files:
              - '**/*'
          cache:
            paths:
              - node_modules/**/*
  YAML

  # The token is write-only in the API; ignore drift so re-applies don't churn.
  lifecycle {
    ignore_changes = [access_token]
  }
}

resource "aws_amplify_branch" "main" {
  count             = var.enable_amplify ? 1 : 0
  app_id            = aws_amplify_app.frontend[0].id
  branch_name       = var.amplify_branch
  framework         = "Next.js - SSR"
  stage             = "PRODUCTION"
  enable_auto_build = true
}
