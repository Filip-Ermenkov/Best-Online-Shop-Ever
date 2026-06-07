# Terraform + provider version pins.
#
# - required_version >= 1.11.0: S3-native state locking (`use_lockfile`) went GA
#   in Terraform 1.11.0, which lets the backend drop DynamoDB entirely. Authored
#   and validated against 1.15.5 (latest stable, June 2026).
# - aws ~> 6.0: the AWS provider 6.x line went GA in April 2026. Pinned to the
#   major to stay protected from the next breaking release while still picking up
#   6.x bug fixes.
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Used only to derive the GitHub OIDC provider's TLS thumbprint at plan time
    # (so we never hard-code a fingerprint that AWS may rotate).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # Zips the esbuild Lambda bundle so `source_code_hash` tracks the artifact.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}
