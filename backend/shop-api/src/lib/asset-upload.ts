/**
 * Pure helpers for the image-upload pipeline (ARCHITECTURE §3.6, §13).
 *
 * The shop stores S3 *keys* on its catalog entities — `products.product_images.
 * s3_key`, `categories.image_s3_key`, `banner_slides.image_s3_key` — and derives
 * the public URL at the edge (`lib/images.ts` → CloudFront). Until this slice
 * there was no way to *put bytes behind a key*: the catalog could only be seeded
 * with keys that pointed at nothing. This module is the DB-free, AWS-free core of
 * the "build once, serve products + categories + banners uniformly" upload path:
 *
 *   browser ──(presigned POST)──▶ S3  pending/<kind>/<uuid>.<ext>
 *                                  │  (s3:ObjectCreated)
 *                                  ▼
 *                          assets-fn validator  ── magic-byte sniff ──▶ reject (delete)
 *                                  │                              └────▶ promote (copy)
 *                                  ▼
 *                              uploads/<kind>/<uuid>.<ext>   ← served via CloudFront(origin_path=/uploads)
 *                                  │
 *                            stored key on the entity = "<kind>/<uuid>.<ext>"
 *
 * Why the work lives here (not inline in the route / the Lambda):
 *   - The route (`routes/admin/uploads.ts`) and the validator (`assets/handler.ts`)
 *     are two separate deployables that MUST agree on the key layout, the
 *     content-type allowlist, and the magic-byte rules. A shared pure module is
 *     the only way that contract can never drift.
 *   - Pure functions unit-test without booting the app, an S3 mock, or AWS creds
 *     — the same split as `lib/category-tree.ts`, `lib/order-status.ts`, and
 *     `lib/product-admin.ts`.
 *
 * Security stance (researched against 2026 practice — see ARCHITECTURE §13):
 *   - Presigned **POST** (not PUT): only the POST policy can pin BOTH a
 *     `content-length-range` and a `Content-Type`, so an over-size or
 *     wrong-type upload is refused by S3 itself, before a byte is stored.
 *   - The client-declared `Content-Type` is **never trusted** as proof of
 *     content. It scopes the presign; the validator re-derives the true type
 *     from the file's magic bytes and rejects any mismatch (`image/svg+xml`,
 *     polyglots, an `.exe` renamed `.jpg`, …). Magic numbers can't be forged
 *     without corrupting the pixels.
 *   - The object key is **server-generated** (random UUID), never client-chosen:
 *     no path traversal, no overwrite of an existing image, no key-guessing.
 */
import { randomUUID } from "node:crypto";

/** The three catalog entities that carry an image. Doubles as the key folder. */
export type AssetKind = "products" | "categories" | "banners";

export const ASSET_KINDS: readonly AssetKind[] = [
  "products",
  "categories",
  "banners",
] as const;

export function isAssetKind(v: string): v is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(v);
}

/**
 * The content-type allowlist. Raster web formats only — no SVG (it is an
 * XML/script vector and a stored-XSS vector if ever served inline), no GIF
 * (legacy, and animation is out of scope for a product photo). AVIF + WebP are
 * the modern, well-supported 2026 delivery formats; JPEG/PNG are the universal
 * source formats an admin will export from any tool.
 *
 * `ext` is the canonical, lowercase, dotless extension the generated key uses.
 */
export interface AllowedImageType {
  readonly contentType: string;
  readonly ext: string;
}

export const ALLOWED_IMAGE_TYPES: readonly AllowedImageType[] = [
  { contentType: "image/jpeg", ext: "jpg" },
  { contentType: "image/png", ext: "png" },
  { contentType: "image/webp", ext: "webp" },
  { contentType: "image/avif", ext: "avif" },
] as const;

export const ALLOWED_CONTENT_TYPES: readonly string[] = ALLOWED_IMAGE_TYPES.map(
  (t) => t.contentType,
);

/** Canonical extension for an allowed content type, or null if not allowed. */
export function extForContentType(contentType: string): string | null {
  const hit = ALLOWED_IMAGE_TYPES.find(
    (t) => t.contentType === contentType.toLowerCase(),
  );
  return hit ? hit.ext : null;
}

/** Canonical content type for an allowed extension, or null if not allowed. */
export function contentTypeForExt(ext: string): string | null {
  const hit = ALLOWED_IMAGE_TYPES.find((t) => t.ext === ext.toLowerCase());
  return hit ? hit.contentType : null;
}

// ─── Key layout ───────────────────────────────────────────────────────────────
//
// pending/<kind>/<uuid>.<ext>   un-validated upload target (CDN cannot reach it:
//                               the assets distribution's origin_path is /uploads)
// uploads/<kind>/<uuid>.<ext>   validated, CDN-served object
// <kind>/<uuid>.<ext>           the key STORED on the entity (the CDN origin_path
//                               supplies the "uploads/" prefix, so the stored key
//                               stays origin-agnostic — same reason images.ts
//                               never stores a fully-qualified URL)

export const PENDING_PREFIX = "pending/";
export const PUBLIC_PREFIX = "uploads/";

export interface AssetKeySet {
  /** Where the browser POSTs the bytes. */
  readonly pendingKey: string;
  /** Where the validator promotes a valid image. */
  readonly publicKey: string;
  /** What the admin saves on the entity (origin-path-relative). */
  readonly storedKey: string;
}

/**
 * Build the three coordinated keys for a new upload. `id` is injectable purely
 * so tests are deterministic; in production it is a fresh random UUID, so two
 * uploads can never collide and an attacker can never predict or overwrite a key.
 */
export function buildAssetKeys(
  kind: AssetKind,
  ext: string,
  id: string = randomUUID(),
): AssetKeySet {
  const tail = `${kind}/${id}.${ext}`;
  return {
    pendingKey: `${PENDING_PREFIX}${tail}`,
    publicKey: `${PUBLIC_PREFIX}${tail}`,
    storedKey: tail,
  };
}

/** uploads/products/x.jpg → products/x.jpg (strip the served prefix). */
export function storedKeyFromPublicKey(publicKey: string): string {
  return publicKey.startsWith(PUBLIC_PREFIX)
    ? publicKey.slice(PUBLIC_PREFIX.length)
    : publicKey;
}

/** pending/products/x.jpg → uploads/products/x.jpg (the validator's promote target). */
export function publicKeyFromPendingKey(pendingKey: string): string {
  const tail = pendingKey.startsWith(PENDING_PREFIX)
    ? pendingKey.slice(PENDING_PREFIX.length)
    : pendingKey;
  return `${PUBLIC_PREFIX}${tail}`;
}

export interface ParsedPendingKey {
  readonly kind: AssetKind;
  readonly id: string;
  readonly ext: string;
}

/**
 * Strictly parse a `pending/<kind>/<uuid>.<ext>` key. Returns null for anything
 * that does not match the exact shape we mint — a defence-in-depth check in the
 * validator so a hand-crafted key (extra path segments, an unknown kind, a
 * disallowed extension, traversal dots) is rejected rather than promoted. The
 * id segment is validated as a UUID so only keys this service minted pass.
 */
export function parsePendingKey(key: string): ParsedPendingKey | null {
  if (!key.startsWith(PENDING_PREFIX)) return null;
  const rest = key.slice(PENDING_PREFIX.length);
  const m = /^([a-z]+)\/([0-9a-f-]{36})\.([a-z0-9]+)$/.exec(rest);
  if (!m) return null;
  const [, kind, id, ext] = m;
  if (!isAssetKind(kind!)) return null;
  if (!UUID_RE.test(id!)) return null;
  if (contentTypeForExt(ext!) === null) return null;
  return { kind: kind as AssetKind, id: id!, ext: ext! };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Request validation (POST /admin/uploads) ────────────────────────────────

export interface UploadRequest {
  readonly kind: string;
  readonly contentType: string;
  readonly contentLength: number;
}

export interface UploadRequestProblem {
  /** Field for the RFC 9457 `errors[]` entry. */
  readonly field: "kind" | "contentType" | "contentLength";
  readonly message: string;
}

export type UploadRequestResult =
  | { ok: true; kind: AssetKind; ext: string }
  | { ok: false; problem: UploadRequestProblem };

/**
 * Validate a mint request against the allowlist and the size cap. The size cap
 * is enforced AGAIN in the S3 POST policy (`content-length-range`) — this check
 * gives the admin a clean field-level 400 instead of an opaque S3 403 on a file
 * that was never going to be accepted.
 */
export function validateUploadRequest(
  req: UploadRequest,
  maxBytes: number,
): UploadRequestResult {
  if (!isAssetKind(req.kind)) {
    return {
      ok: false,
      problem: {
        field: "kind",
        message: `kind must be one of: ${ASSET_KINDS.join(", ")}.`,
      },
    };
  }
  const ext = extForContentType(req.contentType);
  if (ext === null) {
    return {
      ok: false,
      problem: {
        field: "contentType",
        message: `Unsupported image type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}.`,
      },
    };
  }
  if (
    !Number.isInteger(req.contentLength) ||
    req.contentLength <= 0 ||
    req.contentLength > maxBytes
  ) {
    return {
      ok: false,
      problem: {
        field: "contentLength",
        message: `contentLength must be a positive integer no greater than ${maxBytes} bytes.`,
      },
    };
  }
  return { ok: true, kind: req.kind, ext };
}

// ─── Presigned-POST policy (pure params builder) ──────────────────────────────

/**
 * The exact argument object handed to `@aws-sdk/s3-presigned-post`'s
 * `createPresignedPost(client, params)`. Kept pure (no SDK import) so the policy
 * — the security-critical part — is unit-tested without AWS, and the route is a
 * thin `createPresignedPost(client, presignedPostParams(...))` wrapper.
 *
 * Conditions, and why each matters:
 *   - exact `key`: the upload can land at EXACTLY the server-chosen key and
 *     nowhere else (set via `Key`, which S3 turns into an `eq` condition).
 *   - `["content-length-range", 1, maxBytes]`: S3 refuses an empty or over-cap
 *     body — the cap is enforced server-side, not just in the browser.
 *   - `["eq", "$Content-Type", contentType]`: the stored object carries the
 *     declared type; a mismatching multipart field is refused. (Still not
 *     trusted as proof of content — the validator re-checks the bytes.)
 */
export interface PresignedPostParams {
  Bucket: string;
  Key: string;
  Conditions: Array<[string, ...unknown[]] | Record<string, string>>;
  Fields: Record<string, string>;
  Expires: number;
}

export function presignedPostParams(args: {
  bucket: string;
  key: string;
  contentType: string;
  maxBytes: number;
  expiresSeconds: number;
}): PresignedPostParams {
  return {
    Bucket: args.bucket,
    Key: args.key,
    Conditions: [
      ["content-length-range", 1, args.maxBytes],
      ["eq", "$Content-Type", args.contentType],
    ],
    Fields: { "Content-Type": args.contentType },
    Expires: args.expiresSeconds,
  };
}

// ─── Magic-byte sniffing (the validator's core) ───────────────────────────────

/** ASCII for a 4-byte window — used for the container/brand checks below. */
function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len && i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return s;
}

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

const JPEG_SIG = [0xff, 0xd8, 0xff] as const;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Derive the TRUE image content type from the leading bytes, or null if the
 * bytes are not one of the allowlisted raster formats. Only the first ~32 bytes
 * are needed, so the validator range-GETs a tiny head of the object rather than
 * the whole file.
 *
 *   JPEG  FF D8 FF …
 *   PNG   89 'P' 'N' 'G' 0D 0A 1A 0A
 *   WebP  'RIFF' …… 'WEBP'           (RIFF container, WEBP form type at offset 8)
 *   AVIF  …… 'ftyp' 'avif'|'avis'    (ISO-BMFF box; major/compatible brand)
 *
 * Deliberately conservative: it only ever RETURNS a type for a clean match, so
 * a polyglot, a truncated header, or any non-image falls through to null and is
 * rejected by the caller.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, JPEG_SIG)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIG)) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    // The major brand sits at offset 8; compatible brands follow the 4-byte
    // minor-version at 16, 20, … Scan the box head for an AVIF brand so both
    // still images (avif) and sequences (avis) pass.
    const head = ascii(bytes, 8, 24);
    if (head.includes("avif") || head.includes("avis")) return "image/avif";
  }
  return null;
}

/**
 * The validator's accept test: the sniffed type must (a) be an allowlisted
 * image AND (b) match the extension the key claims. (b) catches a real JPEG
 * uploaded under a `.png` key — a benign mismatch, but the served object's
 * extension drives the CDN's Content-Type, so we keep key-ext and bytes honest.
 */
export function uploadedBytesMatchKey(
  bytes: Uint8Array,
  keyExt: string,
): boolean {
  const sniffed = sniffImageType(bytes);
  if (sniffed === null) return false;
  return extForContentType(sniffed) === keyExt.toLowerCase();
}
