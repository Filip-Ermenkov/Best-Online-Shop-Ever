/**
 * Bootstrap the single administrator account.
 *
 * The shop has exactly one admin (docs/ARCHITECTURE.md §1). There is no
 * self-service admin registration — this script is the one-time, out-of-band
 * way to mint it. The created admin has NO MFA yet; on first login the
 * /admin/auth flow returns `enrollment_required` and walks them through TOTP
 * setup (which then issues recovery codes). That keeps the TOTP secret off the
 * command line entirely.
 *
 * Usage (run from the repo root):
 *
 *   # 1. Generate the two admin secrets, put them in your env / SSM:
 *   npm --workspace @shop/api run admin:create -- --print-keys
 *
 *   # 2. Create the admin (env vars preferred — avoids shell history):
 *   ADMIN_EMAIL=admin@shop.bg ADMIN_PASSWORD='a long passphrase' \
 *     npm --workspace @shop/api run admin:create
 *
 *   # …or with flags:
 *   npm --workspace @shop/api run admin:create -- --email admin@shop.bg --password '...'
 *
 * Idempotency: refuses to overwrite an existing account with the same email.
 */

import "dotenv/config";
import { generateMfaKeyBase64, hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { createDb } from "@shop/db/client";
import { eq } from "drizzle-orm";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** NIST SP 800-63B-4: ≥12 chars, no composition rules. Same floor as customers. */
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  if (flag("print-keys")) {
    // 32-byte AES key + a 32-byte HMAC challenge key, both Base64. Never logged
    // anywhere else; copy them straight into SSM / your env file.
    console.log("# Add these to your shop-api environment (SSM in production):");
    console.log(`ADMIN_MFA_ENCRYPTION_KEY=${generateMfaKeyBase64()}`);
    console.log(`ADMIN_MFA_CHALLENGE_KEY=${generateMfaKeyBase64()}`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const email = (arg("email") ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = arg("password") ?? process.env.ADMIN_PASSWORD ?? "";

  if (!email || !email.includes("@")) {
    console.error(
      "Provide an admin email via --email or ADMIN_EMAIL (must look like an address).",
    );
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Admin password must be at least ${MIN_PASSWORD_LENGTH} characters (NIST SP 800-63B-4).`,
    );
    process.exit(1);
  }

  const db = createDb({ databaseUrl, driver: "node-postgres" });

  const [existing] = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) {
    console.error(
      `A user with email ${email} already exists (role=${existing.role}). Refusing to overwrite.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  // .returning() takes no args on the DbClient driver union — select the row
  // back instead of projecting in the insert (matches the project convention).
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "admin",
      accountType: null, // admins have no customer/corporate profile
      emailVerifiedAt: new Date(), // the bootstrap channel IS the verification
      mfaEnabled: false, // enrol TOTP on first login
    })
    .returning();

  console.log(`Created admin ${email} (id=${created!.id}).`);
  console.log("Next: log in at the admin panel — the first login will require");
  console.log("TOTP enrolment, after which your recovery codes are shown once.");
  console.log(
    "Make sure ADMIN_MFA_ENCRYPTION_KEY and ADMIN_MFA_CHALLENGE_KEY are set",
  );
  console.log("in the shop-api environment before that first login.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
