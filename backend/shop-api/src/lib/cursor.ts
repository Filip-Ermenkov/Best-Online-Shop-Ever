import { z } from "zod";

/**
 * Opaque cursor for keyset pagination.
 *
 * Why keyset (a.k.a. cursor) and not OFFSET?
 *   1. OFFSET N forces the DB to skip N rows — O(N) on every page request.
 *   2. OFFSET drifts under concurrent inserts/deletes: items can appear twice
 *      or be skipped when the page boundary shifts.
 *   3. Keyset is O(log N) on the index for any page.
 *
 * Composition. The cursor encodes the LAST row's sort key tuple. The next
 * query becomes `WHERE (sort_key) > (last_sort_key) ORDER BY sort_key LIMIT n`.
 * For ties on a non-unique key we always include the row id as a tiebreaker
 * — guarantees a total order so the same row never lands on two pages.
 *
 * We base64url-encode the JSON. It's opaque to clients and survives URL
 * encoding without escapes. We do NOT cryptographically sign it: a tampered
 * cursor at worst yields a wrong page; it cannot read data the user
 * couldn't already request.
 */
export const cursorPayloadSchema = z.object({
  /** Discriminator — guards against using a cursor across endpoints. */
  k: z.literal("products_v1"),
  /** Sort field tuple. Schema is intentionally a closed union for type safety. */
  s: z.union([
    z.tuple([z.literal("newest"), z.string(), z.string()]), // [kind, createdAt ISO, id]
    z.tuple([z.literal("price_asc"), z.string(), z.string()]), // [kind, priceCents, id]
    z.tuple([z.literal("price_desc"), z.string(), z.string()]),
    z.tuple([z.literal("featured"), z.number(), z.string()]), // [kind, displayOrder, id]
  ]),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
