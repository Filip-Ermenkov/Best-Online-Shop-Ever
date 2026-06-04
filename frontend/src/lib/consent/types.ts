/**
 * Cookie-consent client types.
 *
 * The success shapes are the concrete DTOs inferred server-side and re-exported
 * from `@shop/api` (`backend/shop-api/src/routes/consent.ts`), so the frontend
 * and backend can never drift on the receipt shape — same posture as the
 * address-book and catalog clients. No Hono RPC `AppType` mining.
 */
import type { ConsentCategory, ConsentReceipt, ConsentState } from "@shop/api";

export type { ConsentCategory, ConsentReceipt, ConsentState };

/** The categories the visitor turned ON (essential is always-on, never sent). */
export interface RecordConsentInput {
  acceptedCategories: ConsentCategory[];
}
