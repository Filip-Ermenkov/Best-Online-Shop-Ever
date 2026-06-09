-- Admin MFA slice — activate the dormant TOTP columns the schema has carried
-- since 0000 (mfa_enabled, mfa_secret_encrypted, mfa_recovery_codes) by adding
-- the two pieces of per-user MFA state the verification flow needs.
--
-- New columns on users:
--   mfa_last_used_step — RFC 6238 replay guard. The last TOTP time-step counter
--                        successfully consumed. Verification rejects any code at
--                        a step ≤ this value, so a code is single-use even
--                        inside its 30-second skew window (the top real-world
--                        TOTP defect). bigint: a 30s step index stays well
--                        within range for millennia. Null until first use.
--   mfa_enrolled_at    — timestamptz set the moment mfa_enabled flips true (the
--                        enrolling device proved one code). Drives the audit
--                        trail and any "your MFA changed" out-of-band notice.
--
-- Both nullable, no backfill: existing rows (customers) have no MFA and these
-- stay NULL until an admin enrols. Pure additive change — no rewrite, no lock
-- of consequence on a single-admin table.

ALTER TABLE "users" ADD COLUMN "mfa_last_used_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enrolled_at" timestamp with time zone;
