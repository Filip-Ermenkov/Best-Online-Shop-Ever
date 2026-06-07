# The single genuine runtime secret: the Neon connection string.
#
# Terraform creates the parameter with a placeholder and then ignores its value
# forever (lifecycle.ignore_changes), so the real URL never enters a plan, the
# state, or git through *this* resource. Set it once after the first apply:
#   aws ssm put-parameter --name /<project>-<env>/DATABASE_URL \
#     --type SecureString --overwrite --value 'postgresql://…'
resource "aws_ssm_parameter" "database_url" {
  name        = local.database_url_param
  description = "Neon Postgres connection string for shop-api."
  type        = "SecureString"
  key_id      = local.ssm_kms_key_id
  value       = var.database_url_placeholder
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }
}

# Read the current (out-of-band-set) value back to inject into the Lambda env.
#
# TRADE-OFF (documented in infra/README.md): this places the decrypted secret
# into Terraform state. That is acceptable only because the state backend is an
# encrypted, access-restricted S3 bucket (backend.tf / bootstrap/). The forward
# hardening — have the Lambda fetch this parameter from SSM at cold start — keeps
# the secret out of state entirely; the Lambda role already carries
# ssm:GetParameter + kms:Decrypt, so that change needs no IAM work.
data "aws_ssm_parameter" "database_url" {
  name            = aws_ssm_parameter.database_url.name
  with_decryption = true
}
