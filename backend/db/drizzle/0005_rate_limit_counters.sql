-- Distributed rate-limit counters (production-grade serverless rate limiting).
--
-- Backing store for the application-level limiters on the PUBLIC, unauthenticated
-- surface (guest order placement + lost-tracking-link resend). On Lambda an
-- in-memory limiter is per-container, so the effective ceiling multiplies by the
-- number of warm containers and resets on every cold start. This table moves the
-- counter into Postgres — the state every container already shares — so the limit
-- holds cluster-wide, the same way login_attempts (lockout) and the scheduler
-- claim markers already do. No new infra (no DynamoDB / Redis); see ARCHITECTURE §13.
--
-- Atomicity: the composite primary key lets the limiter increment with a single
--   INSERT … ON CONFLICT (pk) DO UPDATE SET count = count + 1 … RETURNING count
-- statement. Postgres locks the conflicting row and re-reads its latest committed
-- version before applying the UPDATE, so concurrent writers serialise with no lost
-- increments and no advisory lock. `window_start` (a fixed/tumbling window computed
-- app-side) is part of the key, so a new window is just a new row starting at 1 —
-- no reset/CASE logic. Aged-out rows are pruned by the daily retention sweep.
--
-- Pure additive change: new table only, no FK, no backfill, zero PII (`subject`
-- is an opaque key — an IP at most).

CREATE TABLE "rate_limit_counters" (
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_subject_window_start_pk" PRIMARY KEY("bucket","subject","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_idx" ON "rate_limit_counters" USING btree ("window_start");
