output "state_bucket" {
  description = "Name of the S3 bucket created for Terraform state. Put this in ../backend.hcl."
  value       = aws_s3_bucket.state.id
}

output "backend_hcl" {
  description = "Paste-ready backend config for the main stack."
  value       = <<-EOT
    bucket = "${aws_s3_bucket.state.id}"
    key    = "prod/terraform.tfstate"
    region = "${var.aws_region}"
  EOT
}
