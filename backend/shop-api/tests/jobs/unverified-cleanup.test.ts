import { randomUUID } from "node:crypto";
import { schema } from "@shop/db";
import {
  ACCOUNT_DELETION_WARNING_TEMPLATE_ID,
  type EmailTransport,
} from "@shop/email";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runUnverifiedCleanupJob } from "../../src/jobs/unverified-cleanup.js";
import { getDb } from "../../src/lib/db.js";
import {
  _resetEmailTransportForTests,
  getEmailTransport,
  getStubTransportForTests,
  setEmailTransportForTests,
} from "../../src/lib/emails.js";

/**
 * The daily unverified-account cleanup (src/jobs/unverified-cleanup.ts):
 * the day-6 warning (claim + fresh token + email), the day-7 hard delete
 * with FK cascade, every exclusion rail (verified / admin / soft-deleted /
 * already-warned / has-orders), idempotency, warn-claim compensation, and
 * the 180-day login_attempts retention prune.
 */

const NOW = new Date("2026-06-12T01:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let userSeq = 0;

async function seedUser(opts: {
  createdAt: Date;
  verified?: boolean;
  role?: "admin" | "customer";
  warnedAt?: Date | null;
  softDeletedAt?: Date | null;
  fullName?: string;
}) {
  const db = getDb();
  userSeq += 1;
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `unverified-${userSeq}@example.com`,
      passwordHash: "x".repeat(32), // never verified against in these tests
      role: opts.role ?? "customer",
      accountType: (opts.role ?? "customer") === "customer" ? "personal" : null,
      emailVerifiedAt: opts.verified ? daysAgo(1) : null,
      unverifiedDeletionWarningAt: opts.warnedAt ?? null,
      deletedAt: opts.softDeletedAt ?? null,
      createdAt: opts.createdAt,
    })
    .returning();
  if (!user) throw new Error("user seed failed");
  if ((opts.role ?? "customer") === "customer") {
    await db.insert(schema.customerProfiles).values({
      userId: user.id,
      fullName: opts.fullName ?? "Мария Георгиева",
      phone: "+359888000111",
    });
  }
  return user;
}

async function userExists(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return rows.length === 1;
}

describe("runUnverifiedCleanupJob — day-6 warning", () => {
  it("claims, issues a fresh signup token, and sends the warning with the verify link", async () => {
    const user = await seedUser({ createdAt: daysAgo(6.5) });

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result).toEqual({
      warned: 1,
      warningEmailsSent: 1,
      deleted: 0,
      prunedLoginAttempts: 0,
    });

    const db = getDb();
    const [reloaded] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(reloaded?.unverifiedDeletionWarningAt?.toISOString()).toBe(
      NOW.toISOString(),
    );
    // Still present — warning ≠ deletion.
    expect(reloaded?.deletedAt).toBeNull();

    // A FRESH signup-kind verification token was issued for the link.
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(
        and(
          eq(schema.emailVerificationTokens.userId, user.id),
          eq(schema.emailVerificationTokens.kind, "signup"),
        ),
      );
    expect(tokens).toHaveLength(1);

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(1);
    const email = stub.sent[0]!;
    expect(email.templateId).toBe(ACCOUNT_DELETION_WARNING_TEMPLATE_ID);
    expect(email.to).toBe(user.email);
    expect(email.text).toContain("Мария Георгиева");
    // One-click verify URL with the token plaintext.
    expect(stub.extractUrl(email)).toContain(
      "http://localhost:3000/account/verify-email?token=",
    );
  });

  it("does not double-warn (idempotent across re-runs)", async () => {
    await seedUser({ createdAt: daysAgo(6.5) });

    await runUnverifiedCleanupJob({ now: NOW });
    const second = await runUnverifiedCleanupJob({ now: NOW });

    expect(second.warned).toBe(0);
    expect(getStubTransportForTests().sent).toHaveLength(1);
  });

  it("warns nobody outside the day-6→7 window or outside the customer/unverified set", async () => {
    await seedUser({ createdAt: daysAgo(5.5) }); // too young
    await seedUser({ createdAt: daysAgo(6.5), verified: true }); // verified
    await seedUser({ createdAt: daysAgo(6.5), role: "admin" }); // bootstrap admin
    await seedUser({ createdAt: daysAgo(6.5), warnedAt: daysAgo(0.5) }); // already warned
    await seedUser({ createdAt: daysAgo(6.5), softDeletedAt: daysAgo(1) }); // user-requested deletion path owns it

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result.warned).toBe(0);
    expect(getStubTransportForTests().sent).toHaveLength(0);
  });

  it("compensates the claim when the transport refuses, then retries next run", async () => {
    const user = await seedUser({ createdAt: daysAgo(6.5) });

    const failing: EmailTransport = {
      async send() {
        throw new Error("transport down");
      },
    };
    setEmailTransportForTests(failing);
    const first = await runUnverifiedCleanupJob({ now: NOW });
    expect(first).toEqual({
      warned: 1,
      warningEmailsSent: 0,
      deleted: 0,
      prunedLoginAttempts: 0,
    });

    const db = getDb();
    const [afterFail] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(afterFail?.unverifiedDeletionWarningAt).toBeNull();

    _resetEmailTransportForTests();
    getEmailTransport();
    const second = await runUnverifiedCleanupJob({ now: NOW });
    expect(second).toEqual({
      warned: 1,
      warningEmailsSent: 1,
      deleted: 0,
      prunedLoginAttempts: 0,
    });
  });
});

describe("runUnverifiedCleanupJob — day-7 deletion", () => {
  it("hard-deletes a ≥7-day unverified customer, cascading sessions/profile/tokens", async () => {
    const user = await seedUser({
      createdAt: daysAgo(7.5),
      warnedAt: daysAgo(1.5),
    });
    const db = getDb();
    await db.insert(schema.sessions).values({
      idHash: `hash-${randomUUID()}`,
      userId: user.id,
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    await db.insert(schema.emailVerificationTokens).values({
      tokenHash: `tok-${randomUUID()}`,
      userId: user.id,
      kind: "signup",
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result.deleted).toBe(1);
    expect(result.warned).toBe(0); // ≥7d rows are NOT in the warn window

    expect(await userExists(user.id)).toBe(false);
    const sessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(sessions).toHaveLength(0);
    const profiles = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    expect(profiles).toHaveLength(0);
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.userId, user.id));
    expect(tokens).toHaveLength(0);
    // Deletion sends no email — the day-6 warning was the notice.
    expect(getStubTransportForTests().sent).toHaveLength(0);
  });

  it("never deletes verified users, admins, soft-deleted rows, young rows — or anyone with an order", async () => {
    const verified = await seedUser({ createdAt: daysAgo(10), verified: true });
    const admin = await seedUser({ createdAt: daysAgo(10), role: "admin" });
    const softDeleted = await seedUser({
      createdAt: daysAgo(10),
      softDeletedAt: daysAgo(2),
    });
    const young = await seedUser({ createdAt: daysAgo(6.9) });

    // The defence-in-depth rail: unverified AND ≥7d old, but owns an order
    // (the invariant "unverified cannot order" broken on purpose here).
    const withOrder = await seedUser({ createdAt: daysAgo(10) });
    const db = getDb();
    await db.insert(schema.orders).values({
      orderNumber: "2099-03-00001",
      customerId: withOrder.id,
      idempotencyKey: randomUUID(),
      status: "processing",
      paymentMethod: "pay_at_store",
      customerEmail: withOrder.email,
      customerName: "Мария Георгиева",
      customerPhone: "+359888000111",
      subtotalCents: "1000",
      totalCents: "1000",
    });

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result.deleted).toBe(0);

    for (const u of [verified, admin, softDeleted, young, withOrder]) {
      expect(await userExists(u.id)).toBe(true);
    }
  });

  it("deletes overdue accounts even when the warning was never sent (retention wins)", async () => {
    // Scheduler downtime scenario: the account aged past 7 days while no
    // job ran, so no day-6 warning exists. Spec-literal: delete anyway.
    const user = await seedUser({ createdAt: daysAgo(8), warnedAt: null });

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result).toEqual({
      warned: 0,
      warningEmailsSent: 0,
      deleted: 1,
      prunedLoginAttempts: 0,
    });
    expect(await userExists(user.id)).toBe(false);
  });
});

describe("runUnverifiedCleanupJob — login_attempts retention", () => {
  it("prunes attempts older than 180 days and keeps everything newer", async () => {
    const db = getDb();
    await db.insert(schema.loginAttempts).values([
      // Two past the 180-day horizon — must go.
      {
        email: "old1@example.com",
        success: false,
        attemptedAt: daysAgo(181),
      },
      {
        email: "old2@example.com",
        success: true,
        attemptedAt: daysAgo(365),
      },
      // Inside the horizon — must stay (incl. the boundary-ish recent one).
      {
        email: "recent@example.com",
        success: false,
        attemptedAt: daysAgo(179),
      },
      {
        email: "today@example.com",
        success: true,
        attemptedAt: daysAgo(0.01),
      },
    ]);

    const result = await runUnverifiedCleanupJob({ now: NOW });
    expect(result.prunedLoginAttempts).toBe(2);

    const remaining = await db
      .select({ email: schema.loginAttempts.email })
      .from(schema.loginAttempts);
    expect(remaining.map((r) => r.email).sort()).toEqual([
      "recent@example.com",
      "today@example.com",
    ]);
  });
});
