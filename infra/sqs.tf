# Durable email delivery — roadmap item 21.
#
# shop-api (EMAIL_TRANSPORT=sqs) enqueues rendered emails here instead of
# calling SES inline; the email-fn Lambda (email-fn.tf) consumes the queue and
# performs the real SES send. SQS redelivers failures with visibility-timeout
# spacing; after max_receive_count attempts the message parks in the DLQ, where
# the email-dlq-depth alarm (observability.tf) notifies the admin. This is what
# closes the EU 2011/83/EU Art. 8(7) + Art. 11a(2) durable-medium audit margin
# (mandatory 2026-06-19): an SES outage now delays delivery instead of silently
# dropping order-confirmation / status-update / withdrawal emails.
#
# Sizing per AWS prescriptive guidance for SQS→Lambda:
#   - visibility_timeout ≥ 6 × function timeout (+ batching window, which is 0):
#     email-fn runs with timeout 30s → 180s here.
#   - max_receive_count ≥ 5 when Lambda is the consumer.
#   - STANDARD queue, not FIFO: ordering between independent emails is
#     meaningless and FIFO adds throughput ceilings. At-least-once delivery is
#     the accepted trade-off (a rare duplicate email is harmless; a lost one is
#     a compliance gap) — SES itself carries the same duplicate caveat on
#     retried SendEmail calls.
#
# Message bodies are rendered emails and therefore contain personal data: both
# queues are encrypted at rest with the project CMK (SSE-KMS) when
# enable_kms_cmk = true, falling back to SQS-managed SSE (still AES-256)
# otherwise. Messages are deleted on successful send; the 14-day retention
# only matters for stuck/DLQ messages, where it is the redrive + audit margin.

resource "aws_sqs_queue" "email" {
  count = var.enable_email_queue ? 1 : 0
  name  = "${local.name_prefix}-email-queue"

  message_retention_seconds  = 1209600 # 14 days — maximum; outage survival margin
  visibility_timeout_seconds = 180     # 6 × email-fn's 30s timeout (AWS guidance)
  receive_wait_time_seconds  = 20      # long polling (Lambda's poller uses it too)

  kms_master_key_id                 = var.enable_kms_cmk ? aws_kms_key.main[0].key_id : null
  kms_data_key_reuse_period_seconds = var.enable_kms_cmk ? 300 : null
  sqs_managed_sse_enabled           = var.enable_kms_cmk ? null : true
}

resource "aws_sqs_queue" "email_dlq" {
  count = var.enable_email_queue ? 1 : 0
  name  = "${local.name_prefix}-email-dlq"

  message_retention_seconds = 1209600 # 14 days to notice, inspect and redrive

  kms_master_key_id                 = var.enable_kms_cmk ? aws_kms_key.main[0].key_id : null
  kms_data_key_reuse_period_seconds = var.enable_kms_cmk ? 300 : null
  sqs_managed_sse_enabled           = var.enable_kms_cmk ? null : true
}

# Redrive wiring as standalone resources — the two queues reference each other
# (source → DLQ for redrive, DLQ → source for redrive-allow), which would be a
# dependency cycle if expressed inline on the queue resources.
resource "aws_sqs_queue_redrive_policy" "email" {
  count     = var.enable_email_queue ? 1 : 0
  queue_url = aws_sqs_queue.email[0].id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.email_dlq[0].arn
    maxReceiveCount     = var.email_queue_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "email_dlq" {
  count     = var.enable_email_queue ? 1 : 0
  queue_url = aws_sqs_queue.email_dlq[0].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.email[0].arn]
  })
}
