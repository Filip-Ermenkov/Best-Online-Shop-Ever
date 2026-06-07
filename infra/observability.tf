# Alarms fan out through one SNS topic; alarm_email subscribes if provided.
# The five alarms below are ARCHITECTURE §3.10's set. Two depend on components
# that do not exist yet (admin-api, scheduler-fn) and are gated off by default so
# the stack never references unbuilt resources.
resource "aws_sns_topic" "alarms" {
  name              = "${local.name_prefix}-alarms"
  kms_master_key_id = local.sns_kms_key_id
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# (1) API 5xx error rate > 1% over 5 minutes — Lambda Errors ÷ Invocations.
resource "aws_cloudwatch_metric_alarm" "api_5xx_rate" {
  alarm_name          = "${local.name_prefix}-api-5xx-rate"
  alarm_description   = "shop-api error rate above 1% over 5 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "e1"
    expression  = "100 * (m_err / m_inv)"
    label       = "Error rate (%)"
    return_data = true
  }
  metric_query {
    id = "m_err"
    metric {
      namespace   = "AWS/Lambda"
      metric_name = "Errors"
      dimensions  = { FunctionName = aws_lambda_function.shop_api.function_name }
      period      = 300
      stat        = "Sum"
    }
  }
  metric_query {
    id = "m_inv"
    metric {
      namespace   = "AWS/Lambda"
      metric_name = "Invocations"
      dimensions  = { FunctionName = aws_lambda_function.shop_api.function_name }
      period      = 300
      stat        = "Sum"
    }
  }
}

# (3) Lambda p99 duration > 5s over 5 minutes.
resource "aws_cloudwatch_metric_alarm" "api_p99_duration" {
  alarm_name          = "${local.name_prefix}-api-p99-duration"
  alarm_description   = "shop-api p99 duration above 5s over 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = aws_lambda_function.shop_api.function_name }
  extended_statistic  = "p99"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 300
  threshold           = 5000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# (5) SES bounce rate > 5% — only meaningful when SES is managed here.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  count               = var.enable_ses ? 1 : 0
  alarm_name          = "${local.name_prefix}-ses-bounce-rate"
  alarm_description   = "SES bounce rate above 5%."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 3600
  threshold           = 0.05
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# (2) Failed admin logins > 5/hour — needs admin-api (not built). The metric
# filter scans the Lambda log group for a structured `admin_login_failed` event.
resource "aws_cloudwatch_log_metric_filter" "admin_login_failures" {
  count          = var.enable_admin_alarms ? 1 : 0
  name           = "${local.name_prefix}-admin-login-failures"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.event = \"admin_login_failed\" }"

  metric_transformation {
    name          = "AdminLoginFailures"
    namespace     = "${local.name_prefix}/security"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "admin_login_failures" {
  count               = var.enable_admin_alarms ? 1 : 0
  alarm_name          = "${local.name_prefix}-admin-login-failures"
  alarm_description   = "More than 5 failed admin logins in an hour."
  namespace           = "${local.name_prefix}/security"
  metric_name         = "AdminLoginFailures"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 3600
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# (4) EventBridge scheduler failure — needs scheduler-fn (not built).
resource "aws_cloudwatch_metric_alarm" "scheduler_failures" {
  count               = var.enable_scheduler_alarms ? 1 : 0
  alarm_name          = "${local.name_prefix}-scheduler-failures"
  alarm_description   = "EventBridge scheduler reported a failed invocation."
  namespace           = "AWS/Scheduler"
  metric_name         = "InvocationsFailedToBeSentToDeadLetterCount"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 3600
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
