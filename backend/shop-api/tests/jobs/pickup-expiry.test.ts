import { randomUUID } from "node:crypto";
import { schema } from "@shop/db";
import {
  PICKUP_EXPIRED_ADMIN_TEMPLATE_ID,
  type EmailTransport,
} from "@shop/email";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runPickupExpiryJob } from "../../src/jobs/pickup-expiry.js";
import { getDb } from "../../src/lib/db.js";
import {
  _resetEmailTransportForTests,
  getEmailTransport,
  getStubTransportForTests,
  setEmailTransportForTests,
} from "../../src/lib/emails.js";

/**
 * The hourly expired-pickup sweep (src/jobs/pickup-expiry.ts): claim
 * semantics, the spec's "notify, never transition" rule, idempotency under
 * re-runs, and the compensation path when the transport refuses the email.
 */

const NOW = new Date("2026-06-12T09:00:00Z");
const ONE_HOUR = 60 * 60 * 1000;

let orderSeq = 0;

async function makeOrder(opts: {
  status?: (typeof schema.orders.$inferSelect)["status"];
  pickupDeadline?: Date | null;
  notifiedAt?: Date | null;
}) {
  const db = getDb();
  orderSeq += 1;
  const [order] = await db
    .insert(schema.orders)
    .values({
      orderNumber: `2099-02-${String(orderSeq).padStart(5, "0")}`,
      customerId: null,
      idempotencyKey: randomUUID(),
      status: opts.status ?? "ready_for_pickup",
      paymentMethod: "pay_at_store",
      customerEmail: "kupuvach@example.com",
      customerName: "Иван Купувача",
      customerPhone: "+359888123456",
      subtotalCents: "12500",
      totalCents: "12500",
      pickupDeadline: opts.pickupDeadline ?? null,
      pickupExpiredNotifiedAt: opts.notifiedAt ?? null,
    })
    .returning();
  if (!order) throw new Error("order seed failed");
  return order;
}

async function reloadOrder(id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id))
    .limit(1);
  if (!row) throw new Error("order vanished");
  return row;
}

describe("runPickupExpiryJob", () => {
  it("claims an expired ready_for_pickup order and emails the admin — without transitioning it", async () => {
    const expired = await makeOrder({
      pickupDeadline: new Date(NOW.getTime() - ONE_HOUR),
    });

    const result = await runPickupExpiryJob({ now: NOW });
    expect(result).toEqual({ claimed: 1, emailed: 1 });

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(1);
    const email = stub.sent[0]!;
    expect(email.templateId).toBe(PICKUP_EXPIRED_ADMIN_TEMPLATE_ID);
    // Support inbox derived from the default test EMAIL_FROM.
    expect(email.to).toBe("noreply@example.com");
    expect(email.subject).toContain(expired.orderNumber);
    // Customer snapshot present (spec §7: данните на клиента).
    expect(email.text).toContain("Иван Купувача");
    expect(email.text).toContain("+359888123456");
    // Deep link into the admin panel.
    expect(email.text).toContain(`/admin/orders/${expired.orderNumber}`);

    const after = await reloadOrder(expired.id);
    // Marker claimed at the job's injected clock; status untouched.
    expect(after.pickupExpiredNotifiedAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.status).toBe("ready_for_pickup");
  });

  it("is idempotent — a re-run claims nothing and sends nothing", async () => {
    await makeOrder({ pickupDeadline: new Date(NOW.getTime() - ONE_HOUR) });

    await runPickupExpiryJob({ now: NOW });
    const second = await runPickupExpiryJob({ now: NOW });

    expect(second).toEqual({ claimed: 0, emailed: 0 });
    expect(getStubTransportForTests().sent).toHaveLength(1);
  });

  it("skips unexpired deadlines, non-pickup statuses, missing deadlines, and already-notified orders", async () => {
    await makeOrder({
      pickupDeadline: new Date(NOW.getTime() + ONE_HOUR), // still in the future
    });
    await makeOrder({
      status: "accepted", // terminal — customer picked it up
      pickupDeadline: new Date(NOW.getTime() - ONE_HOUR),
    });
    await makeOrder({ pickupDeadline: null }); // never got a deadline
    await makeOrder({
      pickupDeadline: new Date(NOW.getTime() - ONE_HOUR),
      notifiedAt: new Date(NOW.getTime() - ONE_HOUR / 2), // already notified
    });

    const result = await runPickupExpiryJob({ now: NOW });
    expect(result).toEqual({ claimed: 0, emailed: 0 });
    expect(getStubTransportForTests().sent).toHaveLength(0);
  });

  it("compensates the claim when the transport refuses, so the next run retries", async () => {
    const expired = await makeOrder({
      pickupDeadline: new Date(NOW.getTime() - ONE_HOUR),
    });

    const failing: EmailTransport = {
      async send() {
        throw new Error("transport down");
      },
    };
    setEmailTransportForTests(failing);

    const first = await runPickupExpiryJob({ now: NOW });
    expect(first).toEqual({ claimed: 1, emailed: 0 });
    // Claim surrendered — marker back to NULL.
    expect((await reloadOrder(expired.id)).pickupExpiredNotifiedAt).toBeNull();

    // Transport recovers (rebuild the stub from env) → the next run sends.
    _resetEmailTransportForTests();
    getEmailTransport();
    const second = await runPickupExpiryJob({ now: NOW });
    expect(second).toEqual({ claimed: 1, emailed: 1 });
    expect(getStubTransportForTests().sent).toHaveLength(1);
    expect(
      (await reloadOrder(expired.id)).pickupExpiredNotifiedAt,
    ).not.toBeNull();
  });
});
