import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../lib/db.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../lib/errors.js";
import { logger as baseLogger } from "../lib/logger.js";
import { validationHook } from "../lib/validation-hook.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";

/**
 * Customer address book — CRUD over the `addresses` table for the
 * AUTHENTICATED customer who owns the rows.
 *
 * Why this slice exists:
 *
 *   The `addresses` table has shipped in the schema since the initial
 *   migration, and two existing flows already reach into it — the GDPR
 *   data export (`lib/data-export.ts`) lists every address row, and account
 *   deletion (`lib/account-deletion.ts`) hard-deletes them on erasure — but
 *   until this slice there was NO route that could create, read, update or
 *   delete an address. The table was effectively dead: the export always
 *   returned an empty `addresses: []`, and the deletion always deleted
 *   nothing. This slice activates it and ships the "адресна книга"
 *   (address book) the functional spec (docs/README.md §6) describes:
 *   account-holders keep a set of delivery addresses they can reuse.
 *
 * Relationship to checkout:
 *
 *   Order placement (`routes/orders.ts`) does NOT read the address book —
 *   it takes a raw `deliveryAddress` in the request body and SNAPSHOTS it
 *   into the separate `order_delivery_address` table, frozen onto the order
 *   for invoice/contract durability. That means removing a book entry can
 *   never rewrite a past order's delivery address; the two are deliberately
 *   decoupled. A future checkout enhancement can pre-fill the form from the
 *   book and offer "save this address" — the spec's dropdown — without any
 *   change to this CRUD surface.
 *
 * Spec posture (docs/README.md §6):
 *
 *   - There is intentionally NO "default address" concept. The customer
 *     always picks explicitly at checkout, so the book is an unordered set
 *     of equals — no `isDefault` flag, no implicit selection.
 *   - `label` is an optional user-given nickname ("Вкъщи", "Офис").
 *
 * Auth + ownership:
 *
 *   Every route is `requireAuth`-gated. Every row operation is scoped to
 *   `userId = current user` AND `deleted_at IS NULL`, so a request for an
 *   address that does not exist, belongs to someone else, or has been
 *   removed all collapse to the SAME 404 — enumeration-resistant by
 *   contract, mirroring the per-order 404 in routes/orders.ts. No re-auth
 *   (current-password) is required: address data is ordinary profile data
 *   like fullName/phone (which PATCH /auth/me edits without re-auth), NOT a
 *   credential or a one-shot dump of everything we hold — so it follows the
 *   PATCH /auth/me posture, not the change-password / export / delete one.
 *
 * Delete semantics — SOFT delete:
 *
 *   DELETE sets `deleted_at = now()` rather than removing the row. The
 *   schema models this explicitly (the `addresses.deleted_at` column), the
 *   data export already surfaces `deletedAt`, and soft delete is the house
 *   pattern for user-owned rows (users, products). The removed address
 *   simply drops out of the list / get / update surface (all filter
 *   `isNull(deleted_at)`). Full erasure of the row still happens on account
 *   deletion (GDPR Art. 17) where the legal basis for retention ends.
 */

// ─── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One address as returned to the client. We omit `deletedAt` from the public
 * shape because the list/get/update surface only ever returns live rows
 * (soft-deleted ones are filtered out); the export keeps the dedicated
 * `deletedAt` field for the transparency view.
 */
const AddressSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    city: z.string(),
    postalCode: z.string(),
    street: z.string(),
    apartmentOrOffice: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Address");

const AddressesListSchema = z
  .object({
    items: z.array(AddressSchema),
  })
  .openapi("AddressesList");

/** Concrete DTO for the frontend (re-exported from src/types.ts). */
export type Address = z.infer<typeof AddressSchema>;

// ─── Field validators (shared between create + update) ─────────────────────

/**
 * Bulgarian postal codes are exactly four numeric digits (BG uses a 4-digit
 * numeric format — first digit zone, second area, last two locality). Since
 * the shop ships within Bulgaria only there is no country selector, so we
 * can validate the canonical national format directly rather than keeping
 * the loose `max(20)` the checkout body still uses. Trimmed first so a
 * trailing space from a paste doesn't fail an otherwise-valid code.
 */
const PostalCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, "Bulgarian postal code must be exactly 4 digits.");

const CitySchema = z.string().trim().min(1, "City is required.").max(120);
const StreetSchema = z.string().trim().min(1, "Street is required.").max(240);
/** Optional nickname. Empty string is treated as "no label" at handler level. */
const LabelSchema = z.string().trim().max(60);
const ApartmentSchema = z.string().trim().max(120);

const CreateAddressSchema = z
  .object({
    label: LabelSchema.optional(),
    city: CitySchema,
    postalCode: PostalCodeSchema,
    street: StreetSchema,
    apartmentOrOffice: ApartmentSchema.optional(),
  })
  // .strict() — reject unknown keys at the schema layer (defence in depth
  // against a confused-deputy attempt to set columns we don't expose, e.g.
  // `userId` or `deletedAt`). A 400 fires before the handler runs.
  .strict()
  .openapi("CreateAddressRequest");

const UpdateAddressSchema = z
  .object({
    // Every field optional — partial update (RFC 5789 PATCH semantics).
    // `label` and `apartmentOrOffice` accept an explicit null to CLEAR the
    // optional value; the required fields (city/postalCode/street) cannot be
    // nulled, only changed.
    label: LabelSchema.nullable().optional(),
    city: CitySchema.optional(),
    postalCode: PostalCodeSchema.optional(),
    street: StreetSchema.optional(),
    apartmentOrOffice: ApartmentSchema.nullable().optional(),
  })
  .strict()
  .openapi("UpdateAddressRequest");

const AddressIdParamSchema = z.object({
  id: z.string().uuid().openapi({
    param: { name: "id", in: "path" },
    example: "a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
  }),
});

/**
 * Per-user cap on the number of LIVE addresses. The spec describes a small
 * personal address book, not a CRM; a bound keeps a single account from
 * growing the table without limit (and keeps the checkout dropdown sane).
 * Soft-deleted rows do not count against it.
 */
const MAX_ADDRESSES_PER_USER = 20;

// ─── Route definitions ───────────────────────────────────────────────────────

const listAddressesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["addresses"],
  summary: "List the current user's saved delivery addresses",
  responses: {
    200: {
      description: "The user's address book (soft-deleted entries excluded).",
      content: { "application/json": { schema: AddressesListSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const createAddressRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["addresses"],
  summary: "Add a new address to the current user's address book",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateAddressSchema } },
    },
  },
  responses: {
    201: {
      description: "Address created.",
      content: { "application/json": { schema: AddressSchema } },
    },
    400: {
      description: "Validation error (unknown field, bad postal code, etc.).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "The per-user address-book limit has been reached.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const updateAddressRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["addresses"],
  summary: "Update one of the current user's addresses",
  description:
    "Partial update. Every field is optional; only fields present in the " +
    "body are written. `label` and `apartmentOrOffice` accept an explicit " +
    "null to clear them. Sending no changes (or values identical to the " +
    "stored ones) is a no-op that returns the current state.",
  request: {
    params: AddressIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateAddressSchema } },
    },
  },
  responses: {
    200: {
      description: "The updated address (or current state on a no-op).",
      content: { "application/json": { schema: AddressSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description:
        "Address not found, does not belong to this user, or has been removed.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const deleteAddressRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["addresses"],
  summary: "Remove one of the current user's addresses (soft delete)",
  request: { params: AddressIdParamSchema },
  responses: {
    204: {
      description: "Address removed.",
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description:
        "Address not found, does not belong to this user, or already removed.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const addressesRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

// Every route here requires a session. currentUser runs upstream in app.ts.
addressesRoutes.use("*", requireAuth);

addressesRoutes.openapi(listAddressesRoute, async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.addresses)
    .where(
      and(
        eq(schema.addresses.userId, user.id),
        isNull(schema.addresses.deletedAt),
      ),
    )
    // Deterministic order: oldest first, id as tiebreaker. Matches the
    // export's ordering and keeps tests stable.
    .orderBy(asc(schema.addresses.createdAt), asc(schema.addresses.id));
  return c.json({ items: rows.map(shapeAddress) }, 200);
});

addressesRoutes.openapi(createAddressRoute, async (c) => {
  const user = c.get("user")!;
  const body = c.req.valid("json");
  const db = getDb();

  // Enforce the per-user cap on LIVE rows. Soft-deleted addresses don't count.
  // `[cnt]` may be undefined on an empty result per the union driver typing —
  // guard with optional chaining, mirroring lib/data-export.ts.
  const [cnt] = await db
    .select({ n: count() })
    .from(schema.addresses)
    .where(
      and(
        eq(schema.addresses.userId, user.id),
        isNull(schema.addresses.deletedAt),
      ),
    );
  if (Number(cnt?.n ?? 0) >= MAX_ADDRESSES_PER_USER) {
    throw new ApiError({
      type: "/problems/address-limit-reached",
      title: "Address Limit Reached",
      status: 422,
      detail: `You can save at most ${MAX_ADDRESSES_PER_USER} addresses. Remove one before adding another.`,
    });
  }

  const [row] = await db
    .insert(schema.addresses)
    .values({
      userId: user.id,
      label: normaliseOptional(body.label),
      city: body.city,
      postalCode: body.postalCode,
      street: body.street,
      apartmentOrOffice: normaliseOptional(body.apartmentOrOffice),
    })
    .returning();
  if (!row) {
    // Insert returning nothing is an invariant violation, not a user error.
    throw new ApiError({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "Failed to create address.",
    });
  }

  // Audit: row id only, never the address values (those are PII).
  baseLogger.info(
    { userId: user.id, addressId: row.id, ip: clientIp(c) },
    "address_created",
  );

  return c.json(shapeAddress(row), 201);
});

addressesRoutes.openapi(updateAddressRoute, async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = getDb();

  // Load the live, owned row. Not-found / not-yours / removed all 404.
  const [current] = await db
    .select()
    .from(schema.addresses)
    .where(
      and(
        eq(schema.addresses.id, id),
        eq(schema.addresses.userId, user.id),
        isNull(schema.addresses.deletedAt),
      ),
    )
    .limit(1);
  if (!current) {
    throw notFound("Address not found.");
  }

  // Build the diff. label/apartmentOrOffice support explicit null = clear;
  // the others only change. A value identical to the stored one is a no-op.
  const patch: Partial<typeof schema.addresses.$inferInsert> = {};
  const changed: string[] = [];

  if (body.label !== undefined) {
    const next = body.label === null ? null : normaliseOptional(body.label);
    if (next !== current.label) {
      patch.label = next;
      changed.push("label");
    }
  }
  if (body.city !== undefined && body.city !== current.city) {
    patch.city = body.city;
    changed.push("city");
  }
  if (body.postalCode !== undefined && body.postalCode !== current.postalCode) {
    patch.postalCode = body.postalCode;
    changed.push("postalCode");
  }
  if (body.street !== undefined && body.street !== current.street) {
    patch.street = body.street;
    changed.push("street");
  }
  if (body.apartmentOrOffice !== undefined) {
    const next =
      body.apartmentOrOffice === null
        ? null
        : normaliseOptional(body.apartmentOrOffice);
    if (next !== current.apartmentOrOffice) {
      patch.apartmentOrOffice = next;
      changed.push("apartmentOrOffice");
    }
  }

  if (changed.length === 0) {
    // No-op: nothing to write. Return the current state, don't log.
    return c.json(shapeAddress(current), 200);
  }

  const [row] = await db
    .update(schema.addresses)
    .set(patch)
    .where(
      and(
        eq(schema.addresses.id, id),
        eq(schema.addresses.userId, user.id),
        isNull(schema.addresses.deletedAt),
      ),
    )
    .returning();
  if (!row) {
    // Lost a race with a concurrent delete between the read and the update.
    throw notFound("Address not found.");
  }

  // Audit: field NAMES only — never the values (PII). Mirrors profile_updated.
  baseLogger.info(
    { userId: user.id, addressId: id, changed, ip: clientIp(c) },
    "address_updated",
  );

  return c.json(shapeAddress(row), 200);
});

addressesRoutes.openapi(deleteAddressRoute, async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.valid("param");
  const db = getDb();

  // Soft delete: stamp deleted_at on the live, owned row. The WHERE clause's
  // isNull(deletedAt) makes a repeat DELETE on an already-removed row a 404
  // (idempotent-by-absence rather than idempotent-by-success — a second
  // delete of the same id is a client bug worth surfacing, not a silent ok).
  // Bare `.returning()` (all columns) — a column-config arg doesn't typecheck
  // across the node-pg | neon-http DbClient union (same constraint orders.ts
  // documents). We only need to know a live row matched, so `row` truthiness
  // is enough.
  const [row] = await db
    .update(schema.addresses)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(schema.addresses.id, id),
        eq(schema.addresses.userId, user.id),
        isNull(schema.addresses.deletedAt),
      ),
    )
    .returning();
  if (!row) {
    throw notFound("Address not found.");
  }

  baseLogger.info(
    { userId: user.id, addressId: id, ip: clientIp(c) },
    "address_deleted",
  );

  return c.body(null, 204);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Final response shape for one address row. Centralised so list / create /
 * update all emit the identical structure.
 */
function shapeAddress(
  row: typeof schema.addresses.$inferSelect,
): z.infer<typeof AddressSchema> {
  return {
    id: row.id,
    label: row.label ?? null,
    city: row.city,
    postalCode: row.postalCode,
    street: row.street,
    apartmentOrOffice: row.apartmentOrOffice ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Collapse an optional string to a stored value: a trimmed non-empty string
 * stays; undefined / empty-string (after the Zod trim) become null so the
 * column holds a clean null rather than "". Zod has already trimmed and
 * length-checked by the time we get here.
 */
function normaliseOptional(v: string | undefined): string | null {
  if (v === undefined) return null;
  return v.length > 0 ? v : null;
}

/**
 * Best-effort client IP for the audit log. Mirrors the helper used by the
 * auth routes: trust the first hop of X-Forwarded-For when present (set by
 * CloudFront / the proxy in production), else fall back to a marker. Never
 * throws.
 */
function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? null;
  return c.req.header("x-real-ip") ?? null;
}
