# ─────────────────────────────────────────────────────────────────────────────
# SLOs + multi-window multi-burn-rate alerting (roadmap items 24 + 25)
#
# The objective contract is infra/slos.yaml (OpenSLO v1). This file is its
# CloudWatch implementation: structured-log → metric filter → burn-rate alarm.
#
# SLI SOURCE. shop-api emits one INFO `request_end` line per request with
# { method, path, status, durationMs } (app.ts). Five Logs metric filters on the
# shop-api log group turn that line into CloudWatch metrics (same mechanism as
# the existing admin-login-failures filter in observability.tf). No PutMetricData
# call on the request path, no custom-metric SDK — just the log line we already
# write.
#
# ALERTING. Google SRE Workbook "Alerting on SLOs": for each burn tier a LONG
# and a SHORT window must BOTH breach (composite AND) before the alert fires —
# the long window proves a sustained burn (kills noise), the short window makes
# the alert clear quickly once the burn stops. Burn-rate threshold = multiplier
# × error-budget, expressed as an error-rate percent on the SLI:
#
#   tier        long / short   multiplier   avail err-rate (target 99.9%)   severity
#   fast burn   1h   / 5m      14.4x        1.44%                           page
#   slow burn   6h   / 30m     6x           0.60%                           ticket
#
# Availability ships BOTH tiers; the order-success + latency SLOs ship the
# fast-burn page tier (add a slow tier later by copying the composite). Window
# alarms use period = window length, evaluation_periods = 1 — the same shape as
# the existing api-5xx-rate alarm; the 5-minute short-window arm drives fast
# detection, the long-window arm confirms. A finer rolling burn-rate (or AWS
# Application Signals SLOs) is the documented next step — see slos.yaml + §8.4.
#
# Everything here is gated behind `enable_slo_alarms` (default off): zero cost,
# zero metrics, zero alarms until switched on. When on, the deployed Lambda must
# run at log_level = "info" (request_end is INFO) — enforced by a precondition
# on the SLIRequests filter below.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  slo_namespace = "${local.name_prefix}/slo"

  # Error budgets = 1 − target. Burn-rate thresholds are expressed as the SLI
  # error-rate PERCENT the metric-math expressions below return (100 × ratio).
  slo_burn_fast = 14.4 # 1h: consumes 2% of a 30-day budget in the hour → page
  slo_burn_slow = 6    # 6h: consumes 5% of a 30-day budget in six hours → ticket

  slo_avail_fast_pct  = local.slo_burn_fast * (1 - var.slo_availability_target) * 100
  slo_avail_slow_pct  = local.slo_burn_slow * (1 - var.slo_availability_target) * 100
  slo_orders_fast_pct = local.slo_burn_fast * (1 - var.slo_orders_target) * 100

  # Availability burn windows (5xx ÷ total). Same expression, different window +
  # threshold; for_each keeps the four alarms in one readable place.
  slo_avail_windows = var.enable_slo_alarms ? {
    "fast-1h"  = { period = 3600, threshold = local.slo_avail_fast_pct }
    "fast-5m"  = { period = 300, threshold = local.slo_avail_fast_pct }
    "slow-6h"  = { period = 21600, threshold = local.slo_avail_slow_pct }
    "slow-30m" = { period = 1800, threshold = local.slo_avail_slow_pct }
  } : {}

  # Order-success burn windows (5xx ÷ valid attempts), fast tier only.
  slo_orders_windows = var.enable_slo_alarms ? {
    "fast-1h" = { period = 3600, threshold = local.slo_orders_fast_pct }
    "fast-5m" = { period = 300, threshold = local.slo_orders_fast_pct }
  } : {}
}

# ── Metric filters: derive SLI metrics from the request_end log line ──────────

# Total responses (the denominator for availability). Carries the log-level
# precondition for the whole SLO subsystem: request_end is INFO, so the deployed
# Lambda must run at log_level=info or these metrics never populate.
resource "aws_cloudwatch_log_metric_filter" "sli_requests" {
  count          = var.enable_slo_alarms ? 1 : 0
  name           = "${local.name_prefix}-sli-requests"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.msg = \"request_end\" }"

  metric_transformation {
    name          = "SLIRequests"
    namespace     = local.slo_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }

  lifecycle {
    precondition {
      condition     = contains(["info", "debug", "trace"], var.log_level)
      error_message = "enable_slo_alarms requires log_level = \"info\" (or finer): the SLO SLIs are CloudWatch Logs metric filters over the INFO-level request_end log line. Set log_level = \"info\" in terraform.tfvars."
    }
  }
}

# Server errors (the numerator for availability).
resource "aws_cloudwatch_log_metric_filter" "sli_requests_5xx" {
  count          = var.enable_slo_alarms ? 1 : 0
  name           = "${local.name_prefix}-sli-requests-5xx"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.msg = \"request_end\" && $.status >= 500 }"

  metric_transformation {
    name          = "SLIRequests5xx"
    namespace     = local.slo_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Request duration value (the latency SLI). No default_value: quiet periods must
# not inject 0 ms points that would drag the p95 down.
resource "aws_cloudwatch_log_metric_filter" "sli_request_duration" {
  count          = var.enable_slo_alarms ? 1 : 0
  name           = "${local.name_prefix}-sli-request-duration"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.msg = \"request_end\" }"

  metric_transformation {
    name      = "SLIRequestDurationMs"
    namespace = local.slo_namespace
    value     = "$.durationMs"
    unit      = "Milliseconds"
  }
}

# Successful order placements (POST /orders → 201). 4xx are NOT counted — they
# are valid business rejections, not reliability failures.
resource "aws_cloudwatch_log_metric_filter" "sli_orders_placed" {
  count          = var.enable_slo_alarms ? 1 : 0
  name           = "${local.name_prefix}-sli-orders-placed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.msg = \"request_end\" && $.method = \"POST\" && $.path = \"/orders\" && $.status = 201 }"

  metric_transformation {
    name          = "SLIOrdersPlaced"
    namespace     = local.slo_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Failed order placements (POST /orders → 5xx).
resource "aws_cloudwatch_log_metric_filter" "sli_orders_failed" {
  count          = var.enable_slo_alarms ? 1 : 0
  name           = "${local.name_prefix}-sli-orders-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.msg = \"request_end\" && $.method = \"POST\" && $.path = \"/orders\" && $.status >= 500 }"

  metric_transformation {
    name          = "SLIOrdersFailed"
    namespace     = local.slo_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# ── Availability burn-rate window alarms (children of the composites) ─────────
# 5xx ÷ total, as a percent. No alarm_actions: only the composites notify, so a
# single window arm flapping never reaches the operator on its own.
resource "aws_cloudwatch_metric_alarm" "slo_availability" {
  for_each = local.slo_avail_windows

  alarm_name          = "${local.name_prefix}-slo-availability-${each.key}"
  alarm_description   = "SLO availability burn-rate arm (${each.key}): 5xx rate over the window exceeds ${format("%.2f", each.value.threshold)}%."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "100 * (m_bad / m_tot)"
    label       = "5xx rate (%)"
    return_data = true
  }
  metric_query {
    id = "m_bad"
    metric {
      namespace   = local.slo_namespace
      metric_name = "SLIRequests5xx"
      period      = each.value.period
      stat        = "Sum"
    }
  }
  metric_query {
    id = "m_tot"
    metric {
      namespace   = local.slo_namespace
      metric_name = "SLIRequests"
      period      = each.value.period
      stat        = "Sum"
    }
  }

  depends_on = [
    aws_cloudwatch_log_metric_filter.sli_requests,
    aws_cloudwatch_log_metric_filter.sli_requests_5xx,
  ]
}

# Fast burn (page): 1h AND 5m both above 14.4× budget.
resource "aws_cloudwatch_composite_alarm" "slo_availability_fast" {
  count = var.enable_slo_alarms ? 1 : 0

  alarm_name        = "${local.name_prefix}-slo-availability-fast-burn"
  alarm_description = "PAGE: availability error budget burning fast (14.4×) — 1h and 5m windows both breaching. See infra/slos.yaml."
  alarm_rule = join(" AND ", [
    "ALARM(${aws_cloudwatch_metric_alarm.slo_availability["fast-1h"].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.slo_availability["fast-5m"].alarm_name})",
  ])
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# Slow burn (ticket): 6h AND 30m both above 6× budget.
resource "aws_cloudwatch_composite_alarm" "slo_availability_slow" {
  count = var.enable_slo_alarms ? 1 : 0

  alarm_name        = "${local.name_prefix}-slo-availability-slow-burn"
  alarm_description = "TICKET: availability error budget burning steadily (6×) — 6h and 30m windows both breaching. See infra/slos.yaml."
  alarm_rule = join(" AND ", [
    "ALARM(${aws_cloudwatch_metric_alarm.slo_availability["slow-6h"].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.slo_availability["slow-30m"].alarm_name})",
  ])
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# ── Order-placement-success burn-rate window alarms ───────────────────────────
# 5xx ÷ (placed + failed). Empty (no orders) → no datapoint → notBreaching.
resource "aws_cloudwatch_metric_alarm" "slo_orders" {
  for_each = local.slo_orders_windows

  alarm_name          = "${local.name_prefix}-slo-orders-${each.key}"
  alarm_description   = "SLO order-success burn-rate arm (${each.key}): order 5xx rate over the window exceeds ${format("%.2f", each.value.threshold)}%."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "100 * (m_fail / (m_placed + m_fail))"
    label       = "Order 5xx rate (%)"
    return_data = true
  }
  metric_query {
    id = "m_fail"
    metric {
      namespace   = local.slo_namespace
      metric_name = "SLIOrdersFailed"
      period      = each.value.period
      stat        = "Sum"
    }
  }
  metric_query {
    id = "m_placed"
    metric {
      namespace   = local.slo_namespace
      metric_name = "SLIOrdersPlaced"
      period      = each.value.period
      stat        = "Sum"
    }
  }

  depends_on = [
    aws_cloudwatch_log_metric_filter.sli_orders_placed,
    aws_cloudwatch_log_metric_filter.sli_orders_failed,
  ]
}

resource "aws_cloudwatch_composite_alarm" "slo_orders_fast" {
  count = var.enable_slo_alarms ? 1 : 0

  alarm_name        = "${local.name_prefix}-slo-orders-fast-burn"
  alarm_description = "PAGE: order-placement error budget burning fast (14.4×) — 1h and 5m windows both breaching. A 5xx on checkout is a lost sale."
  alarm_rule = join(" AND ", [
    "ALARM(${aws_cloudwatch_metric_alarm.slo_orders["fast-1h"].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.slo_orders["fast-5m"].alarm_name})",
  ])
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# ── Latency SLO: p95 request duration under threshold ─────────────────────────
# Single alarm (not multi-window): a p95 threshold is the standard latency guard,
# and a count-based latency burn-rate would add the most alarms for the least
# marginal value pre-traffic. Evaluated over 3×5min so a lone cold start does not
# trip it. §7.2 aspires to p95<200ms warm; 1000ms here leaves cold-start headroom.
resource "aws_cloudwatch_metric_alarm" "slo_latency_p95" {
  count = var.enable_slo_alarms ? 1 : 0

  alarm_name          = "${local.name_prefix}-slo-latency-p95"
  alarm_description   = "Latency SLO: p95 request duration over 15 minutes exceeds ${var.slo_latency_threshold_ms}ms."
  namespace           = local.slo_namespace
  metric_name         = "SLIRequestDurationMs"
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = var.slo_latency_threshold_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.sli_request_duration]
}
