-- Scheduler slice (roadmap item 23) — the two idempotency markers the
-- scheduled jobs claim-then-act on, plus the partial indexes their sweeps
-- scan. Pure additive change: both columns nullable, no backfill, no rewrite.
--
-- New columns:
--   orders.pickup_expired_notified_at
--       Set by the hourly expired-pickup job in the same UPDATE that selects
--       the order (claim-then-send), so the admin notification email goes out
--       exactly once per order even under at-least-once scheduling. The order
--       itself is NOT transitioned — per docs/README.md §7 the admin decides
--       manually (cancel or re-arrange) after the email/red marking.
--   users.unverified_deletion_warning_at
--       Set by the daily unverified-cleanup job when the day-6 warning email
--       is claimed for sending ("Вашият акаунт ще бъде изтрит утре…"). Day-7
--       deletion is a hard DELETE (no pseudonymised remnant — an unverified
--       customer has no orders, so nothing is legally retained; GDPR
--       Art. 5(1)(e) storage limitation).
--
-- New partial indexes:
--   orders_pickup_expiry_idx     — unnotified ready_for_pickup rows only.
--   users_unverified_cleanup_idx — unverified, not-deleted CUSTOMERS only.
--       role='customer' lives in the predicate so the bootstrap admin
--       (created unverified by scripts/create-admin.ts) is structurally
--       outside every cleanup scan.

ALTER TABLE "orders" ADD COLUMN "pickup_expired_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unverified_deletion_warning_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_pickup_expiry_idx" ON "orders" ("pickup_deadline") WHERE "orders"."status" = 'ready_for_pickup' AND "orders"."pickup_expired_notified_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_unverified_cleanup_idx" ON "users" ("created_at") WHERE "users"."email_verified_at" IS NULL AND "users"."deleted_at" IS NULL AND "users"."role" = 'customer';
