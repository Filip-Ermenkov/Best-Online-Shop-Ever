variable "project" {
  description = "Short project slug; must match the main stack's `project` so names line up."
  type        = string
  default     = "best-online-shop"
}

variable "aws_region" {
  description = "Region for the state bucket. Keep it in eu-central-1 with everything else."
  type        = string
  default     = "eu-central-1"
}
