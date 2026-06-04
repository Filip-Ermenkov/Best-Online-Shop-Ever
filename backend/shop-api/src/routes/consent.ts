import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getOrSetVisitorId, getVisitorId } from "../lib/cookies.js";
import { getDb } from "../lib/db.js";
import { ProblemSchema, internal } from "../lib/errors.js";
import { logger as baseLogger } from "../lib/logger.js";
import { validationHook } from "../lib/validation-hook.js";

/**
 * Cookie-consent receipts — server-side, demonstrable record of which
 * non-essential cookie categories a visitor opted in to, when, and from where.
 *
 * Why this slice exists:
 *
 *   The `cookie_consents` table has shipped in the schema since the initial
 *   migration, and the frontend has long shown a consent banner — but that
 *   banner only ever wrote the choice to `localStorage`. A localStorage record
 *   is owned and freely editable/erasable by the data subject; the CONTROLLER
 *   cannot produce it on demand. GDPR Art. 7(1) requires the opposite: "the
 *   controller SHALL be able to demonstrate that the data subject has
 *   consented." The recognised way to satisfy that — and what EU regulators
 *   (CNIL, the Bulgarian КЗЛД, the EDPB) expect — is a server-side consent
 *   record / receipt capturing who (a pseudonymous identifier), when (a precise
 *   timestamp), what (the categories accepted vs. refused), and the version of
 *   what was shown. This slice activates the previously-dead table and ships
 *   exactly that record. It mirrors the address-book slice, which likewise
 *   activated a table the schema modelled but no route could write.
 *
 * Shape of the record (per EDPB Guidelines 05/2020 + ISO/IEC 29184):
 *
 *   - **Identifier.** An opaque, pseudonymous `visitor_id` held in a
 *     strictly-necessary first-party cookie (`lib/cookies.ts`). No account
 *     link — consent is collected from anonymous visitors too, and the schema
 *     deliberately keeps the table account-agnostic. The GDPR export
 *     (`lib/data-export.ts`) re-associates a signed-in user's CURRENT browser
 *     by reading the same cookie at export time, and discloses that scoping.
 *   - **Timestamp.** `recorded_at` (timestamptz, second precision, ISO-8601 on
 *     the wire) — date-only timestamps have lost regulator cases.
 *   - **Choices.** `accepted_categories` is the set the visitor turned ON;
 *     "refused" is derivable because the presented set is fixed and known
 *     (the `cookie_consent_category` enum: analytics, marketing). Essential
 *     cookies are always-on, need no consent, and are never stored.
 *   - **Version.** The banner/policy version active at the time of choice is
 *     returned in the receipt and emitted on the structured `cookie_consent_
 *     recorded` audit event (durable in the log stream). A per-row column is a
 *     documented near-term enhancement; today the version changes only with a
 *     code deploy, so the audit stream pins it unambiguously by `recorded_at`.
 *
 * Append-only lifecycle:
 *
 *   Every POST INSERTs a new row rather than updating the previous one, so the
 *   table is the full consent lifecycle log (initial grant, later changes,
 *   withdrawal-by-narrowing) the guidance asks for. The "current" state is the
 *   most recent row for the visitor; GET returns exactly that.
 *
 * Anonymous by design:
 *
 *   No `currentUser` / `requireAuth` — consent predates (and is independent of)
 *   any login, so the routes run outside the auth chain, like /csp-report.
 */

// ─── Categories ────────────────────────────────────────────────────────────

/**
 * The opt-in (non-essential) categories. Mirrors the DB enum
 * `cookie_consent_category` exactly. "essential" is intentionally NOT a member:
 * strictly-necessary cookies are always on, require no consent, and are never
 * stored as a choice.
 */
const ConsentCategorySchema = z.enum(["analytics", "marketing"]);
export type ConsentCategory = z.infer<typeof ConsentCategorySchema>;

// ─── DTOs ────────────────────────────────────────────────────────────────────

const RecordConsentSchema = z
  .object({
    // The categories the visitor turned ON. Empty array = "reject all" (only
    // essential). Bounded to keep a malformed payload small; duplicates and
    // ordering are normalised server-side, so the cap is just a sanity guard.
    acceptedCategories: z
      .array(ConsentCategorySchema)
      .max(8)
      .openapi({ example: ["analytics"] }),
  })
  // .strict() — reject unknown keys before the handler runs (defence in depth;
  // a confused client cannot smuggle e.g. `visitorId` or `recordedAt`).
  .strict()
  .openapi("RecordConsentRequest");

const ConsentReceiptSchema = z
  .object({
    /** Receipt id — the `cookie_consents` row id. A stable reference the
     *  visitor (or an auditor) can cite for this exact consent action. */
    id: z.string().uuid(),
    acceptedCategories: z.array(ConsentCategorySchema),
    /** The banner/policy version shown when the choice was made. */
    policyVersion: z.string(),
    recordedAt: z.string(),
  })
  .openapi("ConsentReceipt");

/** GET envelope: the current (latest) receipt, or null if none on record. */
const ConsentStateSchema = z
  .object({ consent: ConsentReceiptSchema.nullable() })
  .openapi("ConsentState");

/** Concrete DTOs for the frontend (re-exported from src/types.ts). */
export type ConsentReceipt = z.infer<typeof ConsentReceiptSchema>;
export type ConsentState = z.infer<typeof ConsentStateSchema>;

// ─── Policy version ──────────────────────────────────────────────────────────

/**
 * The version of the consent banner + privacy notice currently presented.
 * Bump this string whenever the categories, wording, or the linked policy
 * change in a way that should be reflected in new consent records (and that
 * may warrant re-asking existing visitors). Date-stamped for legibility.
 */
export const CONSENT_POLICY_VERSION = "2026-06-03";

// ─── Route definitions ───────────────────────────────────────────────────────

const recordConsentRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["consent"],
  summary: "Record this visitor's cookie-consent choice",
  description:
    "Stores a server-side consent receipt (GDPR Art. 7(1) demonstrability). " +
    "Sets an opaque, strictly-necessary `visitor_id` cookie on first call and " +
    "reuses it thereafter. Append-only: each call adds a new receipt, so the " +
    "table is the visitor's full consent history.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RecordConsentSchema } },
    },
  },
  responses: {
    201: {
      description: "Consent recorded; the receipt is returned.",
      content: { "application/json": { schema: ConsentReceiptSchema } },
    },
    400: {
      description: "Validation error (unknown field or unknown category).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const getConsentRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["consent"],
  summary: "Get this visitor's current cookie-consent receipt",
  description:
    "Returns the most recent consent receipt for the visitor identified by the " +
    "`visitor_id` cookie, or `{ consent: null }` if this browser has never " +
    "recorded a choice. Read-only: does NOT mint a visitor id.",
  responses: {
    200: {
      description: "The current consent state for this visitor.",
      content: { "application/json": { schema: ConsentStateSchema } },
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const consentRoutes = new OpenAPIHono({
  defaultHook: validationHook,
});

consentRoutes.openapi(recordConsentRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();

  // Normalise: de-duplicate and sort so the stored array is deterministic
  // (stable tests, stable equality checks) regardless of client ordering.
  const accepted = [...new Set(body.acceptedCategories)].sort() as ConsentCategory[];

  // Mint-or-reuse the visitor id. A returning browser keeps its id, so its
  // receipts share one key; a fresh browser gets a new id + Set-Cookie.
  const visitorId = getOrSetVisitorId(c);

  const [row] = await db
    .insert(schema.cookieConsents)
    .values({
      visitorId,
      acceptedCategories: accepted,
      ipAddress: coerceInet(clientIp(c)),
      userAgent: c.req.header("user-agent") ?? null,
    })
    .returning();
  if (!row) {
    // Insert returning nothing is an invariant violation, not a user error.
    throw internal("Failed to record consent.");
  }

  // Audit: an explicit, durable consent-event record in the log stream. Unlike
  // the profile/address audit events (field NAMES only, because the values are
  // PII), the CATEGORIES are exactly what a consent record must capture, so we
  // log them — they are not personal data. `policyVersion` pins what was shown.
  baseLogger.info(
    {
      visitorId,
      acceptedCategories: accepted,
      policyVersion: CONSENT_POLICY_VERSION,
      ip: clientIp(c),
    },
    "cookie_consent_recorded",
  );

  return c.json(shapeReceipt(row), 201);
});

consentRoutes.openapi(getConsentRoute, async (c) => {
  const visitorId = getVisitorId(c);
  if (!visitorId) {
    // No cookie ⇒ this browser has never recorded consent. Don't mint an id on
    // a read; just report "no consent on record".
    return c.json({ consent: null }, 200);
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.cookieConsents)
    .where(eq(schema.cookieConsents.visitorId, visitorId))
    .orderBy(desc(schema.cookieConsents.recordedAt))
    .limit(1);

  return c.json({ consent: row ? shapeReceipt(row) : null }, 200);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Final response shape for one consent row. The stored `accepted_categories`
 * is already the normalised opt-in set; we re-assert the element type for the
 * DTO. `policyVersion` is the server constant in force when the row was
 * written (see CONSENT_POLICY_VERSION).
 */
function shapeReceipt(
  row: typeof schema.cookieConsents.$inferSelect,
): ConsentReceipt {
  return {
    id: row.id,
    acceptedCategories: row.acceptedCategories as ConsentCategory[],
    policyVersion: CONSENT_POLICY_VERSION,
    recordedAt: row.recordedAt.toISOString(),
  };
}

/**
 * Best-effort client IP for the consent record + audit log. Mirrors the auth /
 * address helper: trust the first hop of X-Forwarded-For when present (set by
 * CloudFront / the proxy in production), else x-real-ip, else null. Never
 * throws.
 */
function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? null;
  return c.req.header("x-real-ip") ?? null;
}

/**
 * The `cookie_consents.ip_address` column is Postgres `inet`, which rejects a
 * non-address string (a spoofed / malformed X-Forwarded-For would otherwise
 * raise 22P02 and 500 the request). Store the value only when it parses as a
 * plain IPv4/IPv6 literal; otherwise null. A loose-but-safe check — the column
 * is for audit context, not a security control.
 */
function coerceInet(ip: string | null): string | null {
  if (!ip) return null;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(ip) || (ip.includes(":") && ipv6.test(ip)) ? ip : null;
}
