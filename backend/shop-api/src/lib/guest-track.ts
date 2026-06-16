import { randomBytes } from "node:crypto";

/**
 * Guest order-tracking token — the "capability URL" the spec's Гост role uses
 * to reach an order with no account (`docs/README.md` §7 "Проследяване на
 * поръчка"): the link in the order email IS the bearer credential.
 *
 * ── Why this shape (2026 security review) ──────────────────────────────────
 *
 * This is a *capability URL* (W3C TAG "Good Practices for Capability URLs"),
 * NOT a login magic link. The two have different threat models, so the usual
 * magic-link rules (10–15 min expiry, single-use) deliberately do NOT apply:
 *
 *   - It grants read access to ONE order plus two narrow, status-gated actions
 *     (cancel while `processing`; withdraw while `accepted` and < 14 days). It
 *     never escalates privilege, never touches another order, never resets a
 *     password. So the blast radius of a leaked token is one order's already-
 *     denormalised contact data + those two actions.
 *   - The spec requires it to stay valid "безсрочно (докато поръчката
 *     съществува)" — a guest must be able to click last week's email today.
 *     An expiring token would break the product contract.
 *
 * Entropy: 32 bytes (256-bit) from a CSPRNG, base64url-encoded (43 chars). The
 * previous design used `crypto.randomUUID()` (122 random bits) which sits just
 * under OWASP's ≥128-bit floor for unguessable tokens; 256 bits clears it by a
 * wide margin and matches this codebase's other token convention (verification
 * / reset tokens are 32-byte base64url too — see `lib/email-verification.ts`).
 *
 * Storage: the RAW token is stored in `orders.guest_track_token` (the column
 * and its UNIQUE index already exist — no migration). We deliberately do NOT
 * hash it at rest, unlike session / reset tokens, because the data it protects
 * (customer_email / customer_name / customer_phone / delivery address) lives in
 * the SAME row in plaintext. An attacker who can read `guest_track_token` can
 * already read the PII directly, so hashing the token would defend against
 * nothing while costing the ability to re-embed the durable link in later
 * status-update emails (we'd have no way to recover the raw value). The token's
 * only job is to be unguessable from OUTSIDE the database, and 256 CSPRNG bits
 * do that. This trade-off is recorded in ARCHITECTURE.md §13.
 *
 * Leak mitigations that DO apply (capability URLs leak via Referer, history,
 * shoulder-surfing): the API never logs the token (we log order id / number);
 * the `/track` frontend route is served with `Referrer-Policy: no-referrer`;
 * and the find-my-order resend path is rate-limited and enumeration-resistant.
 */

/** Token entropy in bytes. 32 → 256-bit → 43 base64url chars. */
export const GUEST_TRACK_TOKEN_BYTES = 32;

/**
 * Mint a fresh guest tracking token: 256 bits of CSPRNG randomness, base64url.
 * URL-safe (no `+`/`/`/`=`), so it drops straight into `/track/<token>` with no
 * percent-encoding.
 */
export function issueGuestTrackToken(): string {
  return randomBytes(GUEST_TRACK_TOKEN_BYTES).toString("base64url");
}

/**
 * Cheap structural guard. Lets a route reject an obviously-malformed `:token`
 * with the same uniform 404 as a real miss BEFORE touching the database (and
 * before spending a rate-limit slot). We accept the base64url alphabet at a
 * length band that comfortably brackets a 32-byte encode (43 chars) while
 * still admitting the legacy 122-bit UUID tokens (36 chars, but those contain
 * `-` which is in-alphabet) so pre-existing orders remain reachable.
 *
 * NOT a security boundary on its own — the DB lookup is authoritative. This is
 * input hygiene, not authorization.
 */
export function isWellFormedTrackToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(token);
}
