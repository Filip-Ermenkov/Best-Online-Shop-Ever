# @shop/api — the shop API

Hono on Lambda. Same handler runs locally on Node via `@hono/node-server`.

> **Scope note.** This README was written for the original catalog read
> slice and keeps its quick-start + design-rationale role. The API has
> since grown far beyond it — auth (incl. GDPR self-service), cart,
> orders + 14-day withdrawal, address book, consent receipts, CSP
> reporting, **admin auth (TOTP MFA)**, **admin order management**
> (`/admin/orders/*`, 2026-06-10), **admin category management**
> (`/admin/categories/*`, 2026-06-15), **admin product management**
> (`/admin/products/*`, 2026-06-22), the **image-upload pipeline**
> (`/admin/uploads/*` + the `assets-fn` validator Lambda, 2026-06-22),
> **admin banner management** (`/admin/banners/*` + public `GET /banners`,
> 2026-06-29), **admin store settings** (`/admin/settings` + public
> `GET /settings`, 2026-06-30), and the **scheduled jobs**
> (`src/jobs/*` → the `scheduler-fn` Lambda bundle, 2026-06-12). The
> authoritative, up-to-date route
> inventory lives in the root `README.md` → "What's wired up"; the
> machine-readable contract is `GET /openapi.json`. The newest slice is
> **admin store settings** (2026-06-30, roadmap item 48): the fifth admin CRUD
> slice moves operator-editable business config (shop phone, address, hours,
> default pickup window, admin-notification recipient) off environment variables
> onto the runtime-editable `settings` table — changing the shop phone no longer
> needs a redeploy, while secrets stay in env/SSM. A pure typed registry
> (`lib/settings.ts`) validates each value; `GET /settings` (public, edge-cached)
> feeds the storefront contact block, `/admin/settings` (GET + PATCH under a
> document-level optimistic lock + audit) backs the real settings screen. Before
> it, **admin banner management** (2026-06-29, roadmap item 47): the public
> `GET /banners` feeds the homepage hero, and `/admin/banners/*` is the fourth
> admin CRUD slice (list / create / edit + show-hide toggle / reorder / delete,
> `linkUrl` validated to a same-origin path), activating the dormant
> `banner_slides` table and reusing the image-upload pipeline's `banners` kind
> via the shared `ImageUploadField`. Before it, the
> **image-upload pipeline** (2026-06-22, roadmap item 46): `POST /admin/uploads`
> mints a **presigned POST** so the browser uploads an image straight to S3
> (policy-pinned size + type), and the `assets-fn` Lambda magic-byte-validates
> each upload and promotes only genuine images to the CloudFront-served prefix.
> It activates every dormant image key the catalog already stored (no entity
> could previously put bytes behind a key). Pure helpers in `lib/asset-upload.ts`;
> behind `enable_asset_uploads`; rationale in `docs/ARCHITECTURE.md` §13. Just
> before it, **admin product management** (2026-06-22) — the third admin CRUD
> slice (`/admin/products/*`): product CRUD + within-category reorder +
> soft-delete writing a 301 redirect + archive/restore, optimistic-locked on
> `updatedAt` and audit-logged, activating the dormant `products` write surface
> and the `product_images` table. The `/admin/products` frontend was wired to this
> API on 2026-06-27 (with the `ImageUploadField` upload widget), and the upload
> pipeline was live-validated end-to-end that day after three latent-bug fixes —
> a DB-free validator (`logger.ts` no longer forces `DATABASE_URL` on the
> DB-less `assets-fn`), the CloudFront `kms:Decrypt` grant, and the frontend CSP
> origins (see `docs/ARCHITECTURE.md` §13). Also on 2026-06-22,
> the **framework-error mapping** — the global `onError` now returns a
> framework throw's true HTTP status instead of a blanket 500, so a malformed JSON
> request body is `400 /problems/malformed-json` (the pure `lib/error-response.ts`
> classifier), not a 500 that would mislead the client *and* burn the availability
> SLO budget. Before those,
> **distributed (Postgres-backed) rate limiting** (2026-06-19) — the public
> guest limiters (`/track/find` 3/h/IP, `/guest/orders` 30/h/IP) moved off a
> per-container in-memory `Map` onto the `rate_limit_counters` table
> (`lib/rate-limit-db.ts`), so the caps hold cluster-wide on Lambda. The newest
> feature slice was
> **SEO / crawlability** — the anonymous `GET /sitemap` (live-catalog sitemap
> data with accurate `lastmod`) + `GET /redirects/resolve` (serves the 301s the
> category cascade-delete writes), 2026-06-16. Preceded by **guest checkout +
> order tracking** — the anonymous `/guest/orders` + `/track/*` capability
> surface.

## Quick start

```bash
# from repo root, one-time:
npm install                  # installs all workspaces
npm run db:up                # start Docker Postgres
npm run db:migrate           # apply migrations
npm run db:seed              # populate demo data

# in shop-api:
cd backend/shop-api
cp .env.example .env

# run the API:
npm run dev                  # http://localhost:3001
```

Smoke test:

```bash
curl -s http://localhost:3001/health                       | jq
curl -s http://localhost:3001/products                     | jq '.items | length'
curl -s http://localhost:3001/products/wireless-headphones | jq
curl -s -i http://localhost:3001/products | head -20         # see ETag, Cache-Control
curl -s http://localhost:3001/openapi.json | jq '.info'
```

## Tests

Tests run against a separate `shop_test` database on the same Docker
Postgres. The global setup drops & recreates `shop_test` and applies
migrations once per `vitest run`.

```bash
npm run test
# every test runs after a TRUNCATE — full isolation, no leakage.
```

## Endpoints (original catalog slice — see scope note above for the rest)

- `GET /health` — liveness probe.
- `GET /products` — paginated catalog list. Query params:
  - `categorySlug` — filter to a single category (no recursion yet).
  - `inStock=true` — exclude out-of-stock products.
  - `q` — free-text over name and code (ILIKE).
  - `sort` — `featured` (default), `newest`, `price_asc`, `price_desc`.
  - `limit` — page size, max 60, default 24.
  - `cursor` — opaque cursor from a previous response's `nextCursor`.
- `GET /products/:slug` — single product with all images and category breadcrumb.
- `GET /openapi.json` — auto-generated OpenAPI 3.1 spec.

## Why these design choices

Cursor pagination, not OFFSET. OFFSET drifts under concurrent inserts and is
O(N) per page. Keyset is O(log N) and stable.

`Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=60`.
CloudFront caches for 5 minutes; browsers always revalidate via the ETag handshake;
edge serves stale for up to a minute while it refreshes in the background.

RFC 9457 Problem Details for errors. One consistent error contract across every
endpoint. `Content-Type: application/problem+json` makes the error type
unambiguous to clients and CDNs.

OpenAPI 3.1 generated from typed Zod routes. The schemas are also the
runtime validators — no drift between docs and behaviour.

Typed DTOs for the frontend. `@shop/api` re-exports concrete Zod-inferred
shapes from `src/types.ts` (`ProductsPage`, `AdminOrderDetail`, …) that the
frontend's plain-`fetch` clients annotate with. (The earlier `hc<AppType>`
Hono-RPC approach was abandoned — it collapses to `unknown` under
`next build`; see the root README "Browsing the API".)

Drizzle, not Prisma. ~45 ms cold start vs ~320 ms; 7 KB driver vs 1.6 MB.
On Lambda this is the difference between a snappy first request and
"is the website broken?".
