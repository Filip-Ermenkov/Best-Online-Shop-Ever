# TECHSPEC — AWS Инфраструктура на Онлайн Магазина

> Технически документ за хостинг архитектурата на магазина в Amazon Web Services.
> Абстрахиран изцяло от имплементационните детайли в README.md — описва само инфраструктурния слой.
> Последна актуализация: 2026-04-07

---

## Съдържание

1. [Архитектурна схема](#1-архитектурна-схема)
2. [Услуги и отговорности](#2-услуги-и-отговорности)
3. [AWS Well-Architected Framework](#3-aws-well-architected-framework)
4. [Zero-Downtime стратегия](#4-zero-downtime-стратегия)
5. [База данни — Neon PostgreSQL](#5-база-данни--neon-postgresql)
6. [Обработка на изображения](#6-обработка-на-изображения)
7. [Ценови план по мащаб](#7-ценови-план-по-мащаб)
8. [Път за надграждане](#8-път-за-надграждане)

---

## 1. Архитектурна схема

```
                              Интернет
                                  │
                      ┌───────────▼────────────┐
                      │      Amazon Route 53    │
                      │  (DNS: domain.bg,       │
                      │   admin.domain.bg)      │
                      └───────────┬────────────┘
                    ┌─────────────┴──────────────┐
                    │                            │
             shop.domain.bg              admin.domain.bg
                    │                            │
        ┌───────────▼────────────────────────────▼───────────┐
        │                    AWS WAF WebACL                   │
        │   Rate limiting · SQLi/XSS защита · Admin rules     │
        │          AWS Shield Standard (безплатно)            │
        └───────────┬────────────────────────────┬───────────┘
                    │                            │
        ┌───────────▼──────────┐     ┌───────────▼──────────┐
        │   AWS Amplify        │     │   CloudFront          │
        │   Hosting (Gen 2)    │     │   Distribution        │
        │   Next.js SSR/SSG    │     │   (S3 изображения)    │
        │   + вграден CDN      │     └───────────┬──────────┘
        └───────────┬──────────┘                 │
                    │                     ┌──────▼──────┐
                    │                     │  Amazon S3  │
        ┌───────────▼──────────┐          │ (images +   │
        │   AWS Lambda         │          │  backups)   │
        │   shop-api           │          └─────────────┘
        │   (shop routes,      │
        │    cart, orders,     │
        │    auth, search)     │
        └───────────┬──────────┘
                    │
        ┌───────────▼──────────┐
        │   AWS Lambda         │
        │   admin-api          │
        │   (admin panel,      │
        │    order mgmt,       │
        │    product mgmt)     │
        └───────────┬──────────┘
                    │
        ┌───────────▼──────────────────────────────────────┐
        │                 Neon PostgreSQL                   │
        │   (products, categories, orders, users, cart,    │
        │    sessions, discounts, redirects, settings)     │
        └──────────────────────────────────────────────────┘

EventBridge Scheduler ──► Lambda scheduler-fn
  Cron правила:               ├── Daily catalog backup → S3 (03:00)
  - 0 3 * * *                 ├── Cleanup неверифицирани акаунти (7 дни)
  - 0 * * * *                 └── Alert за просрочени поръчки (hourly)

Amazon SES ◄──────────────── Lambda shop-api / admin-api
  (15+ email събития)

Amazon CloudWatch ◄─────────── Всички Lambda функции
  Logs + Metric Alarms:
  - 5xx error rate > 1%
  - Admin login failures > 5/час
  - Lambda duration anomaly
  - EventBridge failures
  - SES bounce rate spike

AWS SSM Parameter Store ◄───── Lambda функции (runtime secrets)
  - NEON_DATABASE_URL
  - JWT_SECRET
  - SES_FROM_ADDRESS
  - ADMIN_MFA_CONFIG

AWS Certificate Manager ◄────── CloudFront + Amplify
  (TLS сертификати, безплатни, auto-renew)
```

---

## 2. Услуги и отговорности

| # | Услуга | Роля в системата | Фиксирана цена (idle) |
|---|--------|------------------|-----------------------|
| 1 | **Amazon Route 53** | DNS за `domain.bg` и `admin.domain.bg`. Hosted zone + A/CNAME записи. | **$0.50/мес.** |
| 2 | **AWS Certificate Manager (ACM)** | SSL/TLS сертификати за двата домейна. Автоматично подновяване — нулева намеса. | **$0.00** |
| 3 | **AWS WAF WebACL** | Firewall прикачен към CloudFront: rate limiting на всички endpoints (вкл. `/track`, `/resend-verification`), SQL injection и XSS защита, по-строги правила само за `admin.domain.bg`. | **$5.00/мес.** |
| 4 | **WAF Managed Rule Groups (×2)** | `AWSManagedRulesCommonRuleSet` (XSS, path traversal, bad inputs) + `AWSManagedRulesSQLiRuleSet`. Покриват OWASP Top 10. | **$2.00/мес.** |
| 5 | **AWS Shield Standard** | Базова Layer 3/4 DDoS защита. Активирана автоматично с всяка CloudFront дистрибуция. | **$0.00** |
| 6 | **AWS Amplify Hosting (Gen 2)** | Хоства Next.js приложението (SSR + SSG/ISR). Вграден CloudFront CDN за HTML, CSS, JS. Атомарни blue/green deployments → нула downtime при всяко публикуване. Автоматичен CI/CD pipeline от Git commit до live. | **$0.00** *(pay-as-you-go)* |
| 7 | **Amazon CloudFront** *(за S3)* | CDN дистрибуция пред S3 bucket-а с изображения. Кешира продуктови/категорийни/банер изображения на edge locations. S3 bucket остава напълно частен. | **$0.00** *(pay-per-request)* |
| 8 | **Amazon S3** | Съхранява предварително оптимизираните WebP версии на всички изображения и ежедневните автоматични backups. Versioning активирано за backup обектите. S3 Lifecycle rule: backups > 90 дни → Glacier Instant Retrieval. | **$0.00** *(плаща се само за съхранени GB)* |
| 9 | **AWS Lambda — `shop-api`** | Цялата бизнес логика на магазина: продуктов каталог, категорийна йерархия, кошница (merge на гост → акаунт), двустъпков checkout с idempotency keys, order lifecycle (7 статуса, optimistic locking), потребителски акаунти (физически/фирми), адресна книга, сесии, пълнотекстово търсене, live autocomplete, 301 redirects, GDPR операции. Runtime: **Node.js**. | **$0.00** *(pay-per-invocation)* |
| 10 | **AWS Lambda — `admin-api`** | Административен панел: управление на поръчки (CSV export), продукти (drag-and-drop наредба, масови операции), категории, акаунти с % отстъпки, банер слайдер, статично съдържание (ToS versioning), настройки, архивиране. MFA валидация при всяка заявка. | **$0.00** *(pay-per-invocation)* |
| 11 | **AWS Lambda — `scheduler`** | Изпълнява автоматизирани задачи по cron: daily backup на каталога в S3 (03:00), изтриване на неверифицирани акаунти (7+ дни), hourly проверка за просрочени поръчки „Готова за вземане". | **$0.00** *(EventBridge free tier)* |
| 12 | **AWS EventBridge Scheduler** | Управлява cron правилата за `scheduler` Lambda. Free tier: 14M invocations/месец. | **$0.00** |
| 13 | **Amazon SES** | Изпраща всички 15+ транзакционни имейли: потвърждение на поръчка, смяна на статус (включително tracking номер при „Изпратена"), верификация при регистрация и смяна на имейл, предупреждение за изтриване на акаунт (ден 6), нулиране на парола, GDPR data export, известие за рекламация, alert за изтекъл срок за вземане. | **$0.00** *(плаща се $0.10 / 1,000 имейла)* |
| 14 | **Amazon CloudWatch Logs** | Структурирано JSON logging от трите Lambda функции. Retention: 30 дни (автоматично изтриване). | **$0.00** *(плаща се $0.50/GB след 5 GB free)* |
| 15 | **Amazon CloudWatch Alarms (×5)** | Известия при: 5xx rate > 1% за 5 мин., неуспешни admin login > 5/час, Lambda p99 duration > 5s, EventBridge scheduler failure, SES bounce rate > 5%. | **$0.00/мес.** *(в always-free tier — 10 standard alarm metrics)* |
| 16 | **AWS SSM Parameter Store** | Съхранява runtime secrets: Neon connection string, JWT signing secret, SES sender address, admin MFA seed. Standard tier е изцяло безплатен. | **$0.00** |
| 17 | **Neon PostgreSQL** | Главната релационна база данни. Пълен PostgreSQL — ACID транзакции, full-text search, foreign keys, JSON. Lambda се свързва директно по SSL без VPC. Connection pooling чрез Neon Proxy (вграден PgBouncer). | **$0.00** *(Free)* **/** **~$19/мес.** *(Launch, pay-as-you-go 0.25 CU always-on)* **/** **~$40/мес.** *(Scale, 99.95% SLA)* |

### Обща фиксирана цена (idle — нулев трафик)

| Конфигурация | Фиксирана цена/мес. |
|---|---|
| С Neon Free tier | **$7.50 ≈ €6.90** |
| С Neon Launch (always-on, без SLA) | **~$26.76 ≈ €24.62** |
| С Neon Scale (always-on, **99.95% SLA**) | **~$47.64 ≈ €43.83** |

---

## 3. AWS Well-Architected Framework

### Стълб 1 — Operational Excellence

| Принцип | Имплементация |
|---|---|
| Infrastructure as Code | Цялата инфраструктура е дефинирана в **Terraform** (HCL) — нулево ръчно кликане в конзолата. Промените минават през code review и `terraform plan` преди apply. |
| Automated deployments | **GitHub Actions** CI/CD pipeline: `git push` → Amplify auto-deploy (frontend) + GitHub Actions → `terraform apply` (инфраструктура) + Lambda deploy (backend). |
| Observability | CloudWatch Logs (JSON структурирани), CloudWatch Alarms за 5 ключови метрики, AWS X-Ray за distributed tracing по желание. |
| Event-driven automation | EventBridge Scheduler за всички cron задачи — без VM, без crontab. |
| Runbooks | Документирани процедури за: DB restore от S3 backup, Lambda rollback, SES production request, Neon upgrade. |

### Стълб 2 — Security

| Принцип | Имплементация |
|---|---|
| Defense in depth | WAF → CloudFront → Lambda → Neon. Всеки слой има собствени контроли. |
| HTTPS everywhere | ACM на всички endpoints. HSTS headers. HTTP → HTTPS redirect на ниво CloudFront. |
| Security headers | CloudFront Response Headers Policy: `Strict-Transport-Security` (max-age=63072000; includeSubDomains; preload), `Content-Security-Policy` (strict nonce-based + `strict-dynamic`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. Нулев допълнителен разход. |
| Least privilege IAM | Всяка Lambda има собствена IAM роля: `shop-api` не може да достъпва `admin-api` ресурси. Нито една функция няма повече права от необходимото. |
| Secrets management | Нито един secret не е hardcoded. Всичко е в SSM Parameter Store, четено at runtime. |
| Password hashing | **Argon2id** (m=64 MB, t=3, p=1) за хеширане на пароли. Целево време за аутентикация: 200-300 ms. Argon2id е memory-hard алгоритъм, устойчив на GPU атаки — стандарт за 2026 по OWASP препоръки. |
| Admin isolation | `admin.domain.bg` е отделен CloudFront behavior с по-строги WAF правила. Отделна Lambda функция. MFA задължително при всяко влизане. |
| Rate limiting | WAF на всички публични endpoints + допълнително в Lambda кода: login (5 опита → 15 мин. блок), resend verification (1/2 мин., 5/24 ч.), guest order lookup (3/час/IP). |
| SQL injection prevention | Parametrized queries навсякъде. WAF SQLi правила. Input validation (Zod) преди всяка DB заявка. |
| Supply chain security | `npm audit` в GitHub Actions CI pipeline. `package-lock.json` locked и committed. Dependabot alerts активирани. Покрива OWASP Top 10:2025 A03 (Software Supply Chain Failures). |
| GDPR | Cookie consent (с еднакво видим бутон „Откажи"), data export (JSON), right to erasure, server-side consent enforcement, auditable consent log. |

### Стълб 3 — Reliability

| Принцип | Имплементация |
|---|---|
| Multi-AZ by default | Lambda е регионална услуга с автоматично multi-AZ. CloudFront е глобална мрежа. S3 — 99.999999999% durability. |
| Automatic recovery | Lambda retries при throttling. CloudWatch Alarms. EventBridge DLQ за failed tasks. |
| Idempotency | Всяка поръчка използва idempotency key. Lambda функциите са idempotent — повторно извикване не създава дублиран ресурс. |
| Backups | Daily automated catalog backup в S3 (versioned, 90-дневен retention). Neon Launch включва PITR (point-in-time recovery) за 7 дни. |
| Graceful degradation | При DB недостъпност: 503 response с graceful error page. CloudWatch alarm + имейл до администратора незабавно. |
| Database reliability | **Neon Scale**: always-on compute, automatic failover, **99.95% SLA**. Neon Launch: always-on, но без SLA и без automatic failover. |

> ⚠️ **Reliability и Neon Free tier:** Neon Free включва само **100 CU-hours/месец** и auto-suspend след 5 мин. неактивност. При default 0.25 CU това означава ~400 wall-clock часа (~13.3 ч/ден). При трафик ≥ Tier 4 (100,000+ посетители/мес.) или при autoscaling до по-висока CU стойност, free tier compute се изчерпва. **Neon Free няма HA (High Availability)** — единствен compute endpoint, без failover, без SLA. Това е **единственият single point of failure** в архитектурата.
>
> 🛑 **Какво НЕ значи "auto-recovery":** Auto-suspend wakeup (5 мин. idle → cold start 300-800 ms при следваща заявка) е **планирано, нормално поведение** — НЕ е SPOF, само е latency penalty. SPOF се отнася за **непланиран outage** на самия Neon компонент: ако Neon control plane или storage layer има инцидент, **няма replica, няма failover, няма SLA-обвързано RTO**. През такъв период сайтът е недостъпен — не се "auto-recovers за няколко минути" по никакъв договорен или архитектурен начин. Neon историята показва инциденти от минути до часове. За магазин с цел "zero downtime", Neon Free (и Launch — той също няма HA) **остават SPOF по определение**. Само Neon Scale премахва database SPOF (HA + automatic failover + 99.95% SLA).
>
> ⚠️ **Защо няма keep-warm ping:** Keep-warm Lambda, пингваща Neon на всеки 4 мин., би държала базата активна 24/7 (720 ч × 0.25 CU = 180 CU-hours/мес.) — което изчерпва 100-те free CU-hours за ~17 дни без нито един клиент. На Neon Free **не се използва keep-warm** — приема се occasional cold start от 300-800 ms при първа заявка след период на неактивност. На Neon Launch/Scale keep-warm е ненужен, тъй като базата никога не се suspend-ва.
>
> ⚠️ **SLA матрица:**
>
> | План | HA | Failover | SLA | SPOF? |
> |---|:---:|:---:|:---:|:---:|
> | Free | ❌ | ❌ | Няма | **Да** |
> | Launch | ❌ | ❌ | Няма | Практически не (always-on, но без гаранция) |
> | Scale | ✅ | ✅ | **99.95%** | Не |

### Стълб 4 — Performance Efficiency

| Принцип | Имплементация |
|---|---|
| Global CDN | CloudFront кешира изображения на 600+ edge locations. Amplify CDN кешира HTML/CSS/JS. |
| HTTP/3 (QUIC) | Активиран на CloudFront — безплатно, без конфигурация от клиента. +10-15% подобрение в time-to-first-byte. Несъвместимите клиенти автоматично fallback към HTTP/2. |
| Pre-optimized images | Sharp.js обработва изображенията при upload (→ WebP variants). Нула overhead при request time. |
| ISR + PPR | **Time-based ISR** (`revalidate: 60`) за категорийни и продуктови страници. **Partial Prerendering (PPR)** (Next.js 16): статична обвивка (снимки, описание) + динамични секции (цена, наличност, кошница) рендирани при всяка заявка. CloudFront кешира pre-rendered HTML shell. **Забележка:** AWS Amplify не поддържа on-demand ISR (`revalidateTag`/`revalidatePath`) — само time-based revalidation. |
| Core Web Vitals | Целеви стойности: **LCP < 2.5s**, **INP < 200ms**, **CLS < 0.1**. Постигат се чрез CDN edge caching, pre-optimized WebP, PPR partial static shell, и HTTP/3. |
| Auto-scaling | Lambda: 0 → 1,000 concurrent executions автоматично. CloudFront абсорбира traffic spikes без конфигурация. |
| Connection pooling | Neon Proxy (вграден PgBouncer, transaction pooling) управлява до 10,000 concurrent client connections. Lambda pool: max 3 connections/instance. |

### Стълб 5 — Cost Optimization

| Принцип | Имплементация |
|---|---|
| Pay-per-use | Lambda, CloudFront, SES, S3 — $0 при нулев трафик. Плащат се само при реално използване. |
| Serverless-first | Без always-on сървъри при старт. Lambda е по-евтино от ECS Fargate до ~10-15M API заявки/месец. |
| S3 lifecycle | Backups > 90 дни → Glacier Instant Retrieval (~$0.004/GB вместо $0.023/GB). |
| Log retention | CloudWatch logs: 30-дневен retention — без натрупване. |
| Cost alerts | AWS Budgets alarm при $30/мес. — проактивно известие. |

### Стълб 6 — Sustainability

| Принцип | Имплементация |
|---|---|
| Zero idle compute | Lambda не консумира ресурси между заявки. ECS Fargate контейнери (not used) работят 24/7 — избягваме ги. |
| Edge caching | Изображенията от CDN edge — минимален origin трафик. |
| Shared infrastructure | Amplify, Lambda, CloudFront са multi-tenant — AWS оптимизира хардуерното натоварване глобално. |

---

## 4. Zero-Downtime стратегия

### 4.1 При деплойменти — Amplify Atomic Deployments

```
Git push
    │
    ▼
Amplify CI Build (изолирана среда)
    │
    ├─── Неуспешен build
    │         └── Старата версия остава активна → 0 downtime
    │
    └─── Успешен build
              │
              ▼
          Атомарен CloudFront origin swap
          Новата версия → 100% трафик
          Старата → достъпна за instant rollback
```

Lambda функциите използват **aliases + weighted traffic shifting**: новата версия получава 0% трафик → smoke test → 100%. При проблем: rollback за секунди.

### 4.2 При traffic spikes — Auto-scaling

- **Lambda**: 0 → 1,000 concurrent executions автоматично, без конфигурация
- **CloudFront**: Глобална мрежа, без capacity limits
- **Neon Launch**: Compute скалира автоматично с натоварването
- **SES**: Managed service — AWS управлява капацитета

### 4.3 При AWS регионален outage

| Услуга | Устойчивост | SLA |
|---|---|---|
| CloudFront | 400+ PoP, multi-region | 99.99% |
| Lambda | Multi-AZ, автоматичен failover | 99.99% |
| S3 | Multi-AZ | 99.99% |
| SES | Multi-AZ managed | 99.9% |
| Neon Scale | HA, automatic failover | **99.95%** |

> ⚠️ При Neon Free или Launch (без HA): Neon е единственият SPOF. При Neon outage динамичните операции спират, но ISR-кешираните страници от CloudFront продължават да се сервират.

Мулти-регионална архитектура (failover към втори AWS регион) е надграждане по Milestone 4.

### 4.4 При DB проблем

| Конфигурация | DB Availability | Поведение при 5 мин. неактивност |
|---|---|---|
| **Neon Free** | ~95-98% практически, без SLA, без HA | Auto-suspend → wakeup penalty 300-800 ms при следващ request. Не е crash, но е деградирало UX. |
| **Neon Launch** | Практически висока, без SLA, без HA | Always-on. Без auto-suspend. Без automatic failover. |
| **Neon Scale** | **99.95% SLA**, HA, automatic failover | Always-on. Без auto-suspend. Automatic failover при проблем. |

### 4.5 При schema migrations — Expand-Contract Pattern

```
Никога: ALTER TABLE orders ADD COLUMN new_field TEXT NOT NULL;
        ^^^ блокира таблицата в production

Правилно:
  Step 1 (Expand):   ADD COLUMN new_field TEXT;              -- backward compatible, deploy
  Step 2 (Migrate):  UPDATE orders SET new_field = ...;      -- fill data, deploy
  Step 3 (Contract): ALTER COLUMN new_field SET NOT NULL;    -- enforce constraint, deploy
```

---

## 5. База данни — Neon PostgreSQL

### Защо Neon (без VPC, без RDS)

- **RDS изисква VPC** → Lambda в VPC = NAT Gateway ($32/мес.) или VPC Interface Endpoints ($7/услуга) за всяка AWS услуга. Избягваме изцяло.
- **Lambda без VPC** = 300-500ms по-бързи cold starts (без ENI attachment при стартиране).
- **Neon** = стандартен PostgreSQL wire protocol. Lambda се свързва по SSL директно — нула VPC конфигурация.

### Neon план сравнение (актуално към април 2026)

> **Важно:** Neon е преминал към **pay-as-you-go** модел. Посочените месечни суми по-долу са изчислени за always-on 0.25 CU (най-малкият compute) + 0.5 GB storage.

| | Free | Launch | Scale |
|---|---|---|---|
| Ценови модел | $0 | **Pay-as-you-go** | **Pay-as-you-go** |
| Compute цена | — | **$0.106/CU-hour** | **$0.222/CU-hour** |
| Storage цена | — | **$0.35/GB/мес.** | **$0.35/GB/мес.** |
| CU-hours/мес. | **100** (при 0.25 CU ≈ 400 wall-clock ч) | Unlimited | Unlimited |
| Auto-suspend | 5 мин. (задължително) | Конфигурируем / **може да се изключи** | Конфигурируем / може да се изключи |
| Autoscaling | До 2 CU | До 16 CU | До 16 CU (fixed до 56 CU) |
| Storage включен | 0.5 GB | Pay-as-you-go | Pay-as-you-go |
| Connection pooling | ✅ PgBouncer (до 10,000 conn.) | ✅ PgBouncer (до 10,000 conn.) | ✅ PgBouncer (до 10,000 conn.) |
| PITR backup | 6 часа, 1 GB cap | ✅ 7 дни | ✅ 30 дни |
| High Availability | ❌ | ❌ | ✅ |
| Automatic failover | ❌ | ❌ | ✅ |
| SLA | Няма | Няма | **99.95%** |
| Cold start (wake-up) | 300-800 ms | — (always-on) | — (always-on) |
| Ефективна цена always-on 0.25 CU | Невъзможно (180 CU-h > 100 лимит) | **~$19/мес.** | **~$40/мес.** |
| **Препоръчан при** | Dev / Tier 0-2 | **Tier 2-4** | **Tier 4+ production с SLA** |

### Connection management в Lambda

```javascript
// ✅ Правилно: инициализация ИЗВЪН handler — reuse между warm invocations
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 3,                    // max 3 connections per Lambda instance
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

export const handler = async (event) => {
  const client = await pool.connect();
  try {
    // ... queries
  } finally {
    client.release();
  }
};

// ❌ Грешно: нова connection при всяко извикване → изчерпване на DB connection pool
export const handler = async (event) => {
  const client = new Client({ connectionString: process.env.NEON_DATABASE_URL });
  await client.connect(); // нова connection всеки път!
  // ...
};
```

---

## 6. Обработка на изображения

Изображенията се обработват **при upload**, не при request time.

> ⚠️ **Lambda Function URLs имат лимит от 6 MB за request payload.** README позволява изображения до 10 MB. Затова upload-ът минава през **S3 Presigned URL** — браузърът качва директно в S3, заобикаляйки Lambda payload лимита.

```
Admin browser
    │
    ├── 1. GET /admin/upload-url → Lambda admin-api генерира S3 presigned PUT URL
    │                               (валиден 15 мин., ограничен до 10 MB, само JPG/PNG)
    │
    ├── 2. PUT директно в S3 (до 10 MB) → оригиналът се качва в temp/ prefix
    │
    └── 3. POST /admin/process-image → Lambda admin-api:
                │
                ├── Изтегля оригинала от S3 temp/
                ├── Sharp.js обработка:
                │   ├── main_1200x1200.webp     (~100 KB)  ← продуктова страница
                │   ├── thumb_400x400.webp      (~30 KB)   ← category grid, search results
                │   └── micro_150x150.webp      (~8 KB)    ← cart thumbnails, order history
                │
                ├── Upload → S3 images/ (три файла/изображение)
                └── Изтрива оригинала от temp/
                        │
                        ▼
                    CloudFront кешира при първо зареждане → сервира от edge
```

**Предимства:**
- Нула image processing overhead при request time — CloudFront директно сервира финалния WebP
- Предсказуем S3 storage размер: ~138KB/изображение × 3 variants = ~414KB, или ~5 снимки × 414KB ≈ **~2MB/продукт**

> Бележка: горните размери включват трите WebP variants. За CloudFront bandwidth изчислението ползваме само variant-а, поискан от потребителя — не всички три.

---

## 7. Ценови план по мащаб

### Методология и допускания

| Параметър | Стойност | Бележка |
|---|---|---|
| S3 storage rate | $0.0245/GB/мес. | eu-central-1 (~6-7% над US East $0.023) |
| CloudFront data out | $0.085/GB | EU, до 10 TB/мес. |
| **CloudFront always-free tier** | **1 TB data + 10M HTTPS req/мес.** | **Always free, не 12-месечен** — прилага се преди paid rate |
| CloudFront HTTPS requests | $1.00/1M req | EU region ($0.01/10K) |
| WAF request processing | **$0.60/1M req** | През WebACL — наслагва се върху всички CloudFront заявки |
| Data per page view | ~250 KB | HTML + изображения (WebP) + JS/CSS amortized за returning visitors. **Чувствителен**: при 24-карта category page с пълни thumbnails може да достигне 500-700 KB/PV. |
| CloudFront requests per page view | ~15 | HTML + images + assets |
| Lambda API заявки per сесия | ~3 | search autocomplete, cart ops, auth (не per page view) |
| Lambda free tier | 1M req + 400K GB-sec/мес. | Always free |
| Amplify SSR free tier | **500K req/мес.** + 100 GB-hours compute | Always free |
| Amplify SSR paid | **$0.30/1M req** + $0.20/GB-hour | След free tier |
| SES rate | $0.10/1,000 имейла | (Първите 12 мес. има 3,000 имейла/мес. free, който игнорираме за дългосрочен бюджет) |
| CloudWatch Logs | $0.50/GB след 5 GB free | |
| **CloudWatch Alarms free tier** | **10 standard-resolution alarm metrics** | Always free — 5-те ни alarms са в free tier |
| Средно имейли per поръчка | 3 | потвърждение + статус update + admin alert |
| S3 storage per продукт | ~2 MB | 5 images × 3 WebP variants × ~138 KB avg |
| Neon Free CU-hours | 100/мес. | При 0.25 CU ≈ 400 wall-clock часа |

### Фиксирани разходи (всички тирове)

| Услуга | Цена/мес. |
|---|---|
| Route 53 (hosted zone) | $0.50 |
| WAF WebACL | $5.00 |
| WAF Managed Rules (×2) | $2.00 |
| CloudWatch Alarms (×5) | $0.00 *(в always-free tier — до 10 standard alarms)* |
| **Общо фиксирани** | **$7.50/мес.** |

> **WAF request processing ($0.60 / 1M req)** не е фиксирано — наслагва се с трафика и се отчита в променливите разходи на всеки тир.

---

### Tier 0 — Infrastructure Idle

**Нулев трафик, нула качени продукти**

| Компонент | Цена |
|---|---|
| Фиксирани | $7.50 |
| Всичко останало | $0.00 |
| Neon Free | $0.00 |

| Конфигурация | **Общо/мес.** | **≈ EUR/мес.** |
|---|---|---|
| С Neon Free | **$7.50** | **€6.90** |
| С Neon Launch | **$26.76** | **€24.62** |

*Минималната базова такса само за да "стои пусната" цялата инфраструктура при буквално нулев трафик.*

---

### Tier 1 — Старт

| Параметър | Стойност |
|---|---|
| Продукти | 50 |
| Изображения в S3 | 50 × 2 MB = 100 MB |
| Уникални посетители/мес. | 500 |
| Page views/мес. | ~2,000 |
| Lambda API заявки/мес. | ~1,500 |
| Поръчки/мес. | ~10 |
| Имейли/мес. | ~30 |

| Компонент | Изчисление | Цена |
|---|---|---|
| Фиксирани | Route 53 + WAF + Alarms (alarms в free tier) | $7.50 |
| S3 images | 0.1 GB × $0.0245 | $0.00 |
| S3 backup | ~15 MB/мес. | $0.00 |
| CloudFront data | 0.5 GB → в 1 TB always-free | $0.00 |
| CloudFront requests | 30K → в 10M always-free | $0.00 |
| WAF request processing | 30K × $0.60/1M | $0.02 |
| Lambda API | 1,500 → в рамките на 1M free tier | $0.00 |
| Amplify SSR | 2,000 → в рамките на 500K free tier | $0.00 |
| SES | 30 имейла → $0.003 | $0.00 |
| CloudWatch Logs | ~0.01 GB → free | $0.00 |
| Neon Free | 500 посет. → DB активна ~2-3 ч/ден ≈ 75 ч × 0.25 CU ≈ **19 CU-h/мес.** → **в рамките на 100 CU-h free** ✅ | $0.00 |

| Конфигурация | **Общо/мес.** | **≈ EUR/мес.** |
|---|---|---|
| С Neon Free | **~$7.52** | **~€6.92** ✅ под €10 |
| С Neon Launch (always-on, без SLA) | **~$26.78** | **~€24.64** |

---

### Tier 2 — Малък магазин

| Параметър | Стойност |
|---|---|
| Продукти | 250 |
| Изображения в S3 | 250 × 2 MB = 500 MB |
| Уникални посетители/мес. | 5,000 |
| Page views/мес. | ~20,000 |
| Lambda API заявки/мес. | ~15,000 |
| Поръчки/мес. | ~100 |
| Имейли/мес. | ~300 |

| Компонент | Изчисление | Цена |
|---|---|---|
| Фиксирани | Route 53 + WAF + Alarms (alarms в free tier) | $7.50 |
| S3 images | 0.5 GB × $0.0245 | $0.01 |
| S3 backup | ~75 MB/мес. | $0.00 |
| CloudFront data | 5 GB → в 1 TB always-free | $0.00 |
| CloudFront requests | 300K → в 10M always-free | $0.00 |
| WAF request processing | 300K × $0.60/1M | $0.18 |
| Lambda API | 15,000 → free tier | $0.00 |
| Amplify SSR | 20,000 → free tier | $0.00 |
| SES | 300 → $0.03 | $0.03 |
| CloudWatch Logs | ~0.03 GB → free | $0.00 |
| Neon Free | 5K посет. → DB активна ~5-6 ч/ден ≈ 165 ч × 0.25 CU ≈ **41 CU-h/мес.** → **в рамките на 100 CU-h free** ✅ | $0.00 |

| Конфигурация | **Общо/мес.** | **≈ EUR/мес.** |
|---|---|---|
| С Neon Free *(приемливо за малки магазини)* | **~$7.72** | **~€7.10** ✅ под €10 |
| С Neon Launch *(препоръчано за production)* | **~$26.98** | **~€24.83** |

---

### Tier 3 — Растеж

| Параметър | Стойност |
|---|---|
| Продукти | 1,000 |
| Изображения в S3 | 1,000 × 2 MB = 2 GB |
| Уникални посетители/мес. | 25,000 |
| Page views/мес. | ~100,000 |
| Lambda API заявки/мес. | ~75,000 |
| Поръчки/мес. | ~500 |
| Имейли/мес. | ~1,500 |

| Компонент | Изчисление | Цена |
|---|---|---|
| Фиксирани | Route 53 + WAF + Alarms (alarms в free tier) | $7.50 |
| S3 images | 2 GB × $0.0245 | $0.05 |
| S3 backup | ~300 MB/мес. | $0.01 |
| CloudFront data | 25 GB → в 1 TB always-free | $0.00 |
| CloudFront requests | 1.5M → в 10M always-free | $0.00 |
| WAF request processing | 1.5M × $0.60/1M | $0.90 |
| Lambda API | 75,000 → free tier | $0.00 |
| Amplify SSR | 100,000 → free tier | $0.00 |
| SES | 1,500 → $0.15 | $0.15 |
| CloudWatch Logs | ~0.15 GB → free | $0.00 |
| Neon Free | ⚠️ 833 PV/ден → DB активна ~8-10 ч/ден ≈ 270 ч × 0.25 CU ≈ **68 CU-h/мес.** → **граничен случай** (100 CU-h free, с autoscale може да надхвърли) | $0.00 ⚠️ |
| Neon Launch | ✅ Препоръчан за production | $19.26 |

| Конфигурация | **Общо/мес.** | **≈ EUR/мес.** |
|---|---|---|
| С Neon Free *(ненадежден за production)* | **~$8.61** | **~€7.92** |
| С Neon Launch *(препоръчано)* | **~$27.87** | **~€25.64** |

> **Ключов момент:** На Tier 3 целият трафик все още се покрива от 1 TB / 10M CloudFront always-free tier. Доминиращият променлив разход вече е WAF request processing ($0.90/мес.) + SES ($0.15/мес.). Neon Launch ($19.26) е препоръчван за production, но не е задължителен от ценова перспектива — общото с Neon Free е **под €10**.

---

### Tier 4 — Популярен магазин

| Параметър | Стойност |
|---|---|
| Продукти | 3,000 |
| Изображения в S3 | 3,000 × 2 MB = 6 GB |
| Уникални посетители/мес. | 100,000 |
| Page views/мес. | ~400,000 |
| Lambda API заявки/мес. | ~300,000 |
| Поръчки/мес. | ~2,000 |
| Имейли/мес. | ~6,000 |

| Компонент | Изчисление | Цена |
|---|---|---|
| Фиксирани | Route 53 + WAF + Alarms (alarms в free tier) | $7.50 |
| S3 images | 6 GB × $0.0245 | $0.15 |
| S3 backup (Glacier след 90 дни) | ~0.9 GB/мес. × $0.023 | $0.02 |
| CloudFront data | 100 GB → в 1 TB always-free | $0.00 |
| CloudFront requests | 6M → в 10M always-free | $0.00 |
| WAF request processing | 6M × $0.60/1M | $3.60 |
| Lambda API | 300,000 → free tier | $0.00 |
| Amplify SSR | 400,000 → free tier | $0.00 |
| SES | 6,000 → $0.60 | $0.60 |
| CloudWatch Logs | ~0.6 GB → free | $0.00 |
| Neon Launch | Always-on 0.25 CU, 10 GB storage | $19.26 |

| **Общо/мес.** | **≈ EUR/мес.** |
|---|---|
| **~$31.13** | **~€28.64** |

> На Tier 4 целият CloudFront трафик все още се покрива от always-free tier (100 GB < 1 TB; 6M < 10M req). Доминиращите променливи разходи са **WAF request processing ($3.60)** и **SES ($0.60)**. Neon Launch ($19.26) е ~62% от сметката. Lambda остава изцяло в free tier.

---

### Tier 5 — Голям трафик

| Параметър | Стойност |
|---|---|
| Продукти | 5,000+ |
| Изображения в S3 | 5,000 × 2 MB = 10 GB |
| Уникални посетители/мес. | 500,000 |
| Page views/мес. | ~2,000,000 |
| Lambda API заявки/мес. | ~1,500,000 |
| Поръчки/мес. | ~10,000 |
| Имейли/мес. | ~30,000 |

| Компонент | Изчисление | Цена |
|---|---|---|
| Фиксирани | Route 53 + WAF + Alarms (alarms в free tier) | $7.50 |
| S3 images + backup | ~11 GB × $0.025 | $0.28 |
| CloudFront data | 500 GB → в 1 TB always-free | $0.00 |
| CloudFront requests | 30M → 10M free + 20M платени × $1.00/1M | $20.00 |
| WAF request processing | 30M × $0.60/1M | $18.00 |
| Lambda API | 1.5M → 500K платени × $0.20/1M + compute в free tier | $0.10 |
| Amplify SSR | 2M → 1.5M платени × $0.30/1M + compute (27.8 GB-h, в 100 GB-h free) | $0.45 |
| SES | 30,000 → $3.00 | $3.00 |
| CloudWatch Logs | ~20 GB → 15 GB платени × $0.50 | $7.50 |
| Neon Launch (~$19) | Always-on 0.25 CU + 0.5 GB storage | $19.26 |

| Конфигурация | **Общо/мес.** | **≈ EUR/мес.** |
|---|---|---|
| С Neon Launch (~$19) | **~$76.09** | **~€70.00** |
| С Neon Scale (~$40, с 99.95% SLA) | **~$96.97** | **~€89.21** |

> На Tier 5 always-free tier-ите все още поглъщат значителна част от трафика: 500 GB ≤ 1 TB CloudFront data, и 10 от 30M HTTPS requests са безплатни. **CloudFront ($20) + WAF ($18) = $38** е доминиращият променлив разход (50% от общото). Lambda compute е под $1/мес. — Lambda остава правилният избор; ECS Fargate break-even е при ~15-20M Lambda заявки/мес.

> **Чувствителност:** Това изчисление приема average ~250 KB/PV. При 500 KB/PV средно (по-реалистично за category pages с пълни thumbnails при cold cache) CloudFront data трафикът става 1 TB → излиза от free tier и започва да добавя ~$0.085/GB. На 1.5 TB → +$42/мес.

---

### Обобщена таблица

| Tier | Продукти | Посетители/мес. | PV/мес. | Поръчки/мес. | С Neon Free | С Neon Launch (~$19) | С Neon Scale (~$40, SLA) |
|:---:|---|---|---|---|---|---|---|
| **0 — Idle** | 0 | 0 | 0 | 0 | **$7.50 ≈ €6.90** ✅ | **$26.76 ≈ €24.62** | **$47.64 ≈ €43.83** |
| **1 — Старт** | 50 | 500 | 2K | 10 | **$7.52 ≈ €6.92** ✅ | **$26.78 ≈ €24.64** | $47.66 |
| **2 — Малък** | 250 | 5,000 | 20K | 100 | **$7.72 ≈ €7.10** ✅ | **$26.98 ≈ €24.83** | $47.86 |
| **3 — Растеж** | 1,000 | 25,000 | 100K | 500 | **$8.61 ≈ €7.92** ⚠️ | **$27.87 ≈ €25.64** | $48.75 |
| **4 — Популярен** | 3,000 | 100,000 | 400K | 2,000 | — | **$31.13 ≈ €28.64** | $52.01 |
| **5 — Голям** | 5,000+ | 500,000 | 2M | 10,000 | — | **$76.09 ≈ €70.00** | **$96.97 ≈ €89.21** |

**Легенда:**
- ✅ = под €10 — постижимо с Neon Free
- ⚠️ = Neon Free CU-hours граничен случай при тази натовареност; технически работи, но без HA, без SLA
- — = Neon Free CU-hours изчерпани; Launch или Scale задължителен

> **Какво се промени спрямо предишната версия:** Изчисленията преди не отчитаха (1) **CloudFront always-free tier 1 TB / 10M req/мес.** — applies as standard за всеки AWS акаунт, прилага се преди paid rate; и (2) **WAF request processing $0.60/1M req** — отделен ред, наслагващ се върху всички CloudFront заявки. Освен това (3) **5-те CloudWatch alarms** са в always-free tier (10 standard alarm metrics безплатни), не отделно $0.50/мес. Нетен ефект: Tier 4 пада от ~€39 на ~€29; Tier 5 пада от ~€102 на ~€70.

### Може ли да остане под €10?

| Условие | Отговор |
|---|---|
| Нулев трафик (infrastructure idle) | ✅ **Да — €6.90/мес.** |
| Tier 1 (50 продукта, 500 посетители) с Neon Free | ✅ **Да — ~€6.92/мес.** |
| Tier 2 (250 продукта, 5,000 посетители) с Neon Free | ✅ **Да — ~€7.10/мес.** |
| Tier 3 (1,000 продукта, 25,000 посетители) с Neon Free | ✅ **Да (граничен) — ~€7.92/мес.** ⚠️ Neon CU-hours може да надхвърлят при autoscale |
| Tier 2+ с Neon Launch (always-on, без SLA) | ❌ **Не — ~€25/мес.+** |
| Гарантиран zero-downtime (SLA 99.95%, Neon Scale) | ❌ **Не — минимум ~€43.83/мес.** |

> **Кратко:** €10/мес. и SLA-backed zero-downtime са взаимно изключващи се. €10 е постижимо на Tier 0-3 с Neon Free (cold start 300-800 ms след auto-suspend, **без HA, без SLA, без failover** — DB остава SPOF). Always-on compute без SLA (Neon Launch) → ~€25/мес. Гарантиран 99.95% SLA (Neon Scale) → ~€44/мес.

> **Защо се "вписват" повече тирове в €10:** CloudFront always-free tier (1 TB data + 10M HTTPS req/мес.) поглъща почти целия трафик до Tier 4 — тоест динамичните разходи са доминирани от WAF request processing ($0.60/1M req), а не от CloudFront както показваше предишната версия на този документ.

---

## 8. Път за надграждане

### Milestone 1 — Neon Free → Neon Launch
**Кога:** При достигане на Tier 2 (5,000+ посетители/мес.) **или** при нужда от always-on compute без cold starts.
**Промяна:** Смяна на `NEON_DATABASE_URL` в SSM Parameter Store + деактивиране на auto-suspend в Neon dashboard. **Нула код промени.**
**Допълнителен разход:** ~+$19/мес. (pay-as-you-go: 0.25 CU always-on)

### Milestone 2 — Neon Launch → Neon Scale
**Кога:** Нужда от **99.95% SLA**, HA с automatic failover, или DB query time p99 > 200ms.
**Промяна:** Plan upgrade в Neon dashboard. **Нула код промени.**
**Допълнителен разход:** ~+$21/мес. (от ~$19 на ~$40 за 0.25 CU always-on)

### Milestone 3 — Lambda → ECS Fargate (само при нужда)
**Кога:** Lambda месечна сметка > $30-40/мес. **ИЛИ** cold start p99 > 2s при критични endpoints.
**Break-even:** Lambda > Fargate (2 контейнера за HA, ~$26/мес. fixed) при ~15-20M Lambda API заявки/мес.
**При настоящата архитектура:** Fargate не е нужен дори при Tier 5 (Lambda сметка: ~$0.55/мес.).
**Промяна:** `shop-api` и `admin-api` Lambda → ECS Fargate service. Terraform модулите се сменят. CloudFront, S3, SES, Neon, Amplify — **без промяна**.

### Milestone 4 — Multi-Region Failover
**Кога:** Нужда от > 99.99% availability SLA или регулаторни изисквания.
**Включва:** Route 53 health checks + failover routing, secondary AWS регион, Neon multi-region replication.
**Допълнителен разход:** ~2× текущите CloudFront + Lambda + Neon разходи за втория регион.

### Upgrade Decision Tree

```
Нужда от SLA 99.95%?
    ├── ДА → Neon Scale (~$40/мес.)
    └── НЕ → Always-on нужен?
                ├── ДА → Neon Launch (~$19/мес.)
                └── НЕ → Neon Free ($0, cold start 300-800ms)

Lambda bill > $40/мес.?
    ├── НЕ → Остани на Lambda
    └── ДА → Мигрирай shop-api + admin-api към ECS Fargate
                    │
                    ▼
            Нужда от мулти-регион?
                ├── НЕ → Готово
                └── ДА → Milestone 4
```

---

*TECHSPEC.md — поддържа се синхронно с архитектурните решения на проекта. Последна актуализация: 2026-04-07.*
