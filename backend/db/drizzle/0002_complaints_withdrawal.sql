-- Withdrawal slice — extend `complaints` with the Art. 11a / Directive 2023/2673
-- durable-medium requirements.
--
-- New columns:
--   customer_email/name/phone — denormalised snapshot of the submitter at
--                               the moment of submission. Nullable at the
--                               column level so the table stays generic
--                               across complaint kinds; the app layer
--                               enforces NOT NULL for reason='withdrawal'
--                               at INSERT time.
--   acknowledged_at           — set when the receipt email was successfully
--                               handed to SES. Null = best-effort send
--                               failed. The withdrawal is still valid.
--
-- New partial unique index:
--   complaints_order_withdrawal_unique — enforces "one withdrawal per
--                                        order". A re-submission returns
--                                        the existing row idempotently
--                                        rather than creating duplicates.

ALTER TABLE "complaints" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "complaints_order_withdrawal_unique" ON "complaints" USING btree ("order_id") WHERE "complaints"."reason" = 'withdrawal';
