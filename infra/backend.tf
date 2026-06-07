# Remote state: an encrypted S3 bucket with native (DynamoDB-free) state locking.
#
# `use_lockfile` writes a small .tflock object via S3 conditional-PUT — GA since
# Terraform 1.11, it removes the old DynamoDB lock table entirely.
#
# Partial configuration: bucket / key / region are supplied at init time so they
# stay out of version control:
#   terraform init -backend-config=backend.hcl
# The state bucket itself is created once by the bootstrap/ stack (chicken/egg).
terraform {
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}
