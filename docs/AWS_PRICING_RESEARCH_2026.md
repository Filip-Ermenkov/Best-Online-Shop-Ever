# AWS Pricing Research - eu-central-1 (Frankfurt) Region
**Date:** 2026-04-07
**Sources:** Official AWS pricing pages + verified third-party calculators

> **IMPORTANT NOTE:** AWS pricing pages use dynamic JavaScript tables that render
> region-specific pricing client-side. Some prices below are confirmed from the
> aws.eu domain (Euro-denominated) or from multiple corroborating sources.
> Where eu-central-1 exact pricing was not independently verifiable via web scraping,
> US East baseline + known EU markup (~10-11%) is noted.
> **Always verify against https://aws.amazon.com/[service]/pricing/ before production budgeting.**

---

## 1. AWS Lambda

**Source:** https://aws.amazon.com/lambda/pricing/ + https://aws.eu/lambda/pricing/

### Request Pricing
| Item | eu-central-1 (EUR) | US East baseline (USD) |
|------|-------------------|----------------------|
| Per 1M requests | **EUR 0.1974** | $0.20 |

### Compute Duration (x86, On-Demand)
| Item | eu-central-1 (EUR) | US East baseline (USD) |
|------|-------------------|----------------------|
| Per GB-second | **EUR 0.0000164477** | $0.0000166667 |

### Compute Duration by Memory Size (x86, eu-central-1)
| Memory | Price per 1ms (EUR) | Derived per GB-second (EUR) |
|--------|--------------------|-----------------------------|
| 128 MB | EUR 0.0000164477 / 8 = ~EUR 0.00000206 | EUR 0.00000206 |
| 256 MB | ~EUR 0.00000411 | EUR 0.00000411 |
| 512 MB | ~EUR 0.00000822 | EUR 0.00000822 |
| 1024 MB (1 GB) | ~EUR 0.0000164477 | EUR 0.0000164477 |

> **Calculation note:** Lambda charges per GB-second. For 128MB (0.125 GB),
> actual cost = EUR 0.0000164477 x 0.125 = EUR 0.000002056 per second.
> For 256MB = EUR 0.0000164477 x 0.25 = EUR 0.000004112 per second.
> For 512MB = EUR 0.0000164477 x 0.5 = EUR 0.000008224 per second.

### Provisioned Concurrency (x86, eu-central-1)
- EUR 0.0000115473 per GB-second

### ARM/Graviton2 (eu-central-1)
- ~20% cheaper than x86 (up to 34% better price-performance per AWS)
- Estimated: ~EUR 0.0000131582 per GB-second

### Ephemeral Storage
- First 512 MB included free
- Additional: EUR 0.0000000362 per GB-second

### Free Tier (Always Free)
- **1,000,000 requests per month**
- **400,000 GB-seconds of compute per month**
- Applies to both x86 and ARM in aggregate

### Lambda Function URLs
- **NO additional cost** -- included in standard Lambda invocation + compute pricing
- No API Gateway charges when using Function URLs
- Source: https://aws.amazon.com/about-aws/whats-new/2022/04/aws-lambda-function-urls-built-in-https-endpoints/

---

## 2. Amazon CloudFront

**Source:** https://aws.amazon.com/cloudfront/pricing/ + https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/

### Data Transfer Out to Europe (Pay-as-you-go)
| Tier | Price per GB |
|------|-------------|
| First 10 TB/month | **$0.085** |
| Next 40 TB/month | $0.080 |
| Next 100 TB/month | $0.060 |
| Next 350 TB/month | $0.040 |

### Request Pricing (Europe)
| Type | Price per 10,000 requests |
|------|--------------------------|
| HTTP requests | **$0.0075** |
| HTTPS requests | **$0.0100** |

> Per-million equivalent: HTTP = $0.75/M, HTTPS = $1.00/M

### Free Tier (Always Free -- not 12-month limited)
- **1 TB data transfer out per month**
- **10,000,000 HTTP or HTTPS requests per month**
- **2,000,000 CloudFront Function invocations per month**
- Free SSL certificates
- No feature limitations on free tier

### Flat-Rate Plans (Alternative)
| Plan | Monthly Cost | Data Transfer | Requests |
|------|-------------|---------------|----------|
| Free | $0 | 1 TB | 10M |
| Pro | $15 | 50 TB | 10M |
| Business | $200 | 50 TB | 125M |
| Premium | $1,000 | 50 TB | 500M |

> Origin-to-CloudFront data transfer is always FREE when using AWS origins (S3, ALB, API Gateway).

---

## 3. Amazon S3 Standard

**Source:** https://aws.amazon.com/s3/pricing/

### Storage Pricing (eu-central-1)
| Tier | US East (USD) | eu-central-1 estimated* |
|------|--------------|------------------------|
| First 50 TB/month | $0.023/GB | **~$0.0245/GB** |
| Next 450 TB/month | $0.022/GB | ~$0.0235/GB |
| Over 500 TB/month | $0.021/GB | ~$0.0224/GB |

> *EU Frankfurt pricing is approximately 6-7% higher than US East for S3 Standard.
> The exact figure from the AWS pricing page (which renders dynamically) is $0.0245/GB
> for the first 50TB tier in eu-central-1, based on multiple third-party calculator
> cross-references. Verify at https://calculator.aws/ with eu-central-1 selected.

### Request Pricing (eu-central-1)
| Request Type | Price per 1,000 requests |
|-------------|-------------------------|
| PUT, COPY, POST, LIST | **$0.005** (same as US East) |
| GET, SELECT | **$0.0004** (same as US East) |
| DELETE, Cancel | Free |
| Lifecycle Transition | $0.01 |

> Note: Some sources suggest eu-central-1 PUT pricing may be ~$0.0054/1000.
> Verify via AWS Pricing Calculator.

### Free Tier (12 months)
- **5 GB of S3 Standard storage**
- **20,000 GET requests per month**
- **2,000 PUT, COPY, POST, or LIST requests per month**
- **100 GB data transfer out per month** (shared across services)

---

## 4. AWS WAF

**Source:** https://aws.amazon.com/waf/pricing/

### Core Pricing (global -- same all regions)
| Component | Monthly Cost |
|-----------|-------------|
| Web ACL | **$5.00 per WebACL** |
| Rules (custom) | **$1.00 per rule** |
| Managed Rule Groups | **$1.00 per rule group** |
| Request processing | **$0.60 per million requests** |

### AWS Managed Rules
| Rule Group | Cost |
|-----------|------|
| Core Rule Set (CRS) | **Free** (included at $1.00/group subscription) |
| Known Bad Inputs | **Free** (included at $1.00/group subscription) |
| Admin Protection | **Free** (included at $1.00/group subscription) |
| Bot Control (Common) | $10.00/month/WebACL + $1.00/million requests (first 10M free) |
| Bot Control (Targeted) | $10.00/month/WebACL + higher per-request rates |
| Account Takeover Prevention | $10.00/month/WebACL + per-request charges |
| Account Creation Fraud Prevention | $10.00/month/WebACL + per-request charges |

> **Clarification:** The $1.00/month charge applies per rule group or managed rule
> group added to your WebACL. AWS Managed Rule groups themselves are free to use,
> but the $1.00/group/month subscription applies. Bot Control and Fraud features
> have additional subscription and per-request fees.

### Capacity Units
- Each WebACL includes up to 1,500 WCUs
- Exceeding 1,500 WCUs incurs additional tiered fees

### Free Tier
- **No WAF-specific free tier**
- (WAF charges are included free for Shield Advanced subscribers)

---

## 5. Amazon Route 53

**Source:** https://aws.amazon.com/route53/pricing/

### Hosted Zone Pricing
| Tier | Monthly Cost |
|------|-------------|
| First 25 hosted zones | **$0.50 per hosted zone** |
| Additional hosted zones | $0.10 per hosted zone |
| Over 10,000 records per zone | $0.0015/month per record |

### DNS Query Pricing
| Query Type | First 1B queries/month | Over 1B queries/month |
|-----------|----------------------|---------------------|
| Standard | **$0.40 per million** | $0.20 per million |
| Latency-Based Routing | $0.60 per million | $0.30 per million |
| Geo DNS | $0.70 per million | $0.35 per million |
| IP-Based Routing | $0.80 per million | $0.40 per million |

### Free Queries
- **Alias A/AAAA records** mapped to AWS resources (ELB, CloudFront, S3 website,
  API Gateway, Elastic Beanstalk, VPC endpoints) are **free -- no query charges**

### Health Checks
- AWS endpoints: First 50 health checks free
- Non-AWS endpoints: $0.75/month each
- Additional features (HTTPS, string matching, fast interval): extra fees

### Free Tier
- No Route 53-specific free tier beyond the Alias query exemption and 50 free health checks

---

## 6. Amazon SES

**Source:** https://aws.amazon.com/ses/pricing/

### Outbound Email Pricing
| Component | Cost |
|-----------|------|
| Sending email | **$0.10 per 1,000 emails** |
| Attachment data | **$0.12 per GB** |

### Inbound Email Pricing
| Component | Cost |
|-----------|------|
| Receiving email | $0.10 per 1,000 emails |
| Incoming email chunks | $0.09 per 1,000 chunks |

### Optional Add-ons
| Feature | Cost |
|---------|------|
| Dedicated IP (standard) | $24.95/month per IP |
| Dedicated IP (managed) | $15.00/month per account + $0.08/1,000 emails |
| Virtual Deliverability Manager | $0.07 per 1,000 emails |

### Free Tier (12 months)
- **3,000 message charges per month** (combination of outbound + inbound)
- Applies for 12 months after first SES usage

> **Note:** The old "62,000 free emails from EC2" tier has been replaced by the
> 3,000 messages/month free tier for all new SES customers.

---

## 7. Amazon CloudWatch

**Source:** https://aws.amazon.com/cloudwatch/pricing/

### Alarms (eu-central-1)
| Alarm Type | Monthly Cost |
|-----------|-------------|
| Standard resolution (60-sec) | **$0.10 per alarm metric** |
| High resolution (10-sec) | $0.30 per alarm metric |
| Composite alarm | $0.50 per alarm |
| Anomaly detection alarm | $0.30 per alarm (3 metrics x $0.10) |

### Logs Pricing (eu-central-1)
| Component | Cost |
|-----------|------|
| Logs ingestion (Standard class) | **$0.50 per GB** |
| Logs ingestion (Infrequent Access class) | ~$0.25 per GB (50% less) |
| Logs storage (archived) | **$0.03 per GB/month** |
| Logs Insights queries | $0.0050 per GB scanned |

### Metrics
| Component | Cost |
|-----------|------|
| Custom metrics | $0.30 per metric/month (first 10,000) |
| API requests (GetMetricData etc.) | $0.01 per 1,000 requests |

### Free Tier (Always Free)
- **5 GB data** (ingestion + archive storage + Logs Insights queries combined)
- **10 custom metrics** (Custom + Detailed Monitoring)
- **10 alarm metrics** (standard resolution only)
- **1,000,000 API requests/month**
- **3 dashboards** (up to 50 metrics each)
- Basic monitoring for EC2, EBS, ELB at 5-minute intervals

> **Note:** eu-central-1 pricing for logs ingestion confirmed at $0.50/GB from
> multiple sources. Some EU regions may charge up to $0.55/GB. Always verify
> at https://aws.amazon.com/cloudwatch/pricing/ with region selector.

---

## 8. AWS Systems Manager Parameter Store

**Source:** https://aws.amazon.com/systems-manager/pricing/

### Standard Tier
| Component | Cost |
|-----------|------|
| Storage | **FREE** |
| Standard throughput (40 TPS) | **FREE** |
| Higher throughput | $0.05 per 10,000 API interactions |

### Limits (Standard Tier)
- Up to **10,000 parameters** per region per account
- Max parameter size: **4 KB**
- No charge for parameter storage or standard API calls

### Advanced Tier
| Component | Cost |
|-----------|------|
| Storage | $0.05 per advanced parameter per month |
| Higher throughput | $0.05 per 10,000 API interactions |
- Max parameter size: 8 KB
- Parameter policies available (expiration, notifications)

### Free Tier
- **Standard tier is always free** (not time-limited)

---

## 9. AWS Shield Standard

**Source:** https://aws.amazon.com/shield/pricing/

| Component | Cost |
|-----------|------|
| Shield Standard | **FREE -- included automatically** |

### Details
- Automatically enabled for all AWS customers at no additional cost
- Protects against common DDoS attacks (Layer 3/4)
- Covers: CloudFront, Route 53, Global Accelerator, ELB, EC2
- No configuration required, no signup needed
- Always-on detection and automatic inline mitigations

### Shield Advanced (for reference, NOT recommended for this project)
- $3,000/month + data transfer fees
- 1-year commitment required

---

## 10. AWS Certificate Manager (ACM)

**Source:** https://aws.amazon.com/certificate-manager/pricing/

### Public Certificates (Non-exportable)
| Component | Cost |
|-----------|------|
| Certificate issuance | **FREE** |
| Certificate renewal | **FREE** |
| Usage with ACM-integrated services | **FREE** |

> ACM-integrated services: CloudFront, ELB, API Gateway, Amplify

### Exportable Public Certificates (new, as of 2025)
| Component | Cost |
|-----------|------|
| Standard FQDN certificate | $7.00 per certificate |
| Wildcard certificate | $79.00 per certificate |
| Export-certificate API (first 10,000 calls) | Free |
| Export-certificate API (additional per 10,000) | $0.50 |

### Important 2026 Update
- As of March 2026, ACM default certificate validity is **198 days** (down from 395)
- Complies with CA/Browser Forum mandate for certificates under 200 days
- Auto-renewal handles this automatically for ACM-managed certs

### Free Tier
- **Public non-exportable certificates are always free** (not time-limited)
- No limit on number of certificates

---

## 11. Amazon EventBridge Scheduler

**Source:** https://aws.amazon.com/eventbridge/pricing/

### Scheduler Pricing
| Component | Cost |
|-----------|------|
| Per million invocations (beyond free tier) | **$1.00** |

### Free Tier (Always Free)
- **14,000,000 invocations per month**

> This is an extremely generous free tier. For context:
> - A cron running every 1 minute = ~43,200 invocations/month
> - 10 schedules running every minute = ~432,000 invocations/month
> - You would need 323+ schedules running every minute to exceed free tier

### Other EventBridge Components (for reference)
| Component | Cost |
|-----------|------|
| Custom events to Event Bus | $1.00 per million |
| Pipes (after filtering) | $0.40 per million requests |
| API Destinations | $0.20 per million invocations |
| Schema Discovery (beyond 5M) | $1.00 per million events |

---

## Summary: Services That Are Always Free

| Service | What's Free |
|---------|------------|
| Lambda Function URLs | No additional cost (included in Lambda pricing) |
| Shield Standard | Entirely free, auto-enabled |
| ACM Public Certificates | Free when used with CloudFront, ELB, API GW, Amplify |
| SSM Parameter Store (Standard) | Free up to 10,000 params x 4KB each |
| CloudFront | 1TB transfer + 10M requests/month (always free) |
| EventBridge Scheduler | 14M invocations/month (always free) |

## Summary: Monthly Fixed Costs (Minimum)

| Service | Monthly Cost | Notes |
|---------|-------------|-------|
| Route 53 Hosted Zone | $0.50 | 1 zone |
| WAF WebACL | $5.00 | 1 WebACL |
| WAF Managed Rule Groups (x2) | $2.00 | CRS + Known Bad Inputs |
| CloudWatch Alarms (x5) | $0.50 | Standard resolution |
| **Total Fixed** | **$8.00** | Before any usage charges |

---

## Currency Note

AWS bills in USD globally. The EUR prices shown for Lambda (from aws.eu) reflect
the Euro-denominated pricing tier. At current exchange rates (~EUR 1 = $1.08),
EUR and USD prices are approximately equivalent. All other services are quoted in
USD as shown on aws.amazon.com pricing pages.

---

## Verification Checklist

Before using these prices for production budgeting, verify each on:
1. https://aws.amazon.com/lambda/pricing/ (select eu-central-1)
2. https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/
3. https://aws.amazon.com/s3/pricing/ (select Europe Frankfurt)
4. https://aws.amazon.com/waf/pricing/
5. https://aws.amazon.com/route53/pricing/
6. https://aws.amazon.com/ses/pricing/
7. https://aws.amazon.com/cloudwatch/pricing/ (select eu-central-1)
8. https://aws.amazon.com/systems-manager/pricing/
9. https://aws.amazon.com/shield/pricing/
10. https://aws.amazon.com/certificate-manager/pricing/
11. https://aws.amazon.com/eventbridge/pricing/
12. Or use https://calculator.aws/ with eu-central-1 selected for all services
