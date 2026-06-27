import { describe, expect, it } from "vitest";
import {
  ALLOWED_CONTENT_TYPES,
  ASSET_KINDS,
  buildAssetKeys,
  contentTypeForExt,
  extForContentType,
  isAssetKind,
  parsePendingKey,
  presignedPostParams,
  publicKeyFromPendingKey,
  sniffImageType,
  storedKeyFromPublicKey,
  uploadedBytesMatchKey,
  validateUploadRequest,
} from "../../src/lib/asset-upload.js";

/** Build a byte head from a leading signature plus optional trailing padding. */
function head(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}
function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

// Minimal but real format heads (only the leading bytes the sniffer reads).
const JPEG = head(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"));
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
const WEBP = head(
  ...ascii("RIFF"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...ascii("WEBP"),
  ...ascii("VP8 "),
);
const AVIF = head(
  0x00,
  0x00,
  0x00,
  0x20,
  ...ascii("ftyp"),
  ...ascii("avif"),
  0x00,
  0x00,
  0x00,
  0x00,
  ...ascii("avifmif1miaf"),
);
const GIF = head(...ascii("GIF89a"), 0x01, 0x00);
const SVG = head(...ascii('<svg xmlns="http://www.w3.org/2000/svg">'));
const TEXT = head(...ascii("not an image at all"));

describe("asset-upload — content-type allowlist", () => {
  it("maps every allowed content type to its canonical extension and back", () => {
    expect(extForContentType("image/jpeg")).toBe("jpg");
    expect(extForContentType("image/png")).toBe("png");
    expect(extForContentType("image/webp")).toBe("webp");
    expect(extForContentType("image/avif")).toBe("avif");
    expect(contentTypeForExt("jpg")).toBe("image/jpeg");
    expect(contentTypeForExt("webp")).toBe("image/webp");
  });

  it("is case-insensitive on the content type", () => {
    expect(extForContentType("IMAGE/JPEG")).toBe("jpg");
  });

  it("rejects disallowed types (svg, gif, anything else)", () => {
    expect(extForContentType("image/svg+xml")).toBeNull();
    expect(extForContentType("image/gif")).toBeNull();
    expect(extForContentType("application/pdf")).toBeNull();
    expect(contentTypeForExt("svg")).toBeNull();
    expect(contentTypeForExt("exe")).toBeNull();
  });

  it("exposes the allowed content types for the 400 message", () => {
    expect(ALLOWED_CONTENT_TYPES).toContain("image/jpeg");
    expect(ALLOWED_CONTENT_TYPES).not.toContain("image/svg+xml");
  });
});

describe("asset-upload — kinds + key layout", () => {
  it("recognises exactly the three catalog kinds", () => {
    for (const k of ASSET_KINDS) expect(isAssetKind(k)).toBe(true);
    expect(isAssetKind("orders")).toBe(false);
    expect(isAssetKind("")).toBe(false);
  });

  it("builds coordinated pending / public / stored keys", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const keys = buildAssetKeys("products", "jpg", id);
    expect(keys.pendingKey).toBe(`pending/products/${id}.jpg`);
    expect(keys.publicKey).toBe(`uploads/products/${id}.jpg`);
    expect(keys.storedKey).toBe(`products/${id}.jpg`);
  });

  it("uses a fresh UUID per upload when no id is injected", () => {
    const a = buildAssetKeys("banners", "png");
    const b = buildAssetKeys("banners", "png");
    expect(a.pendingKey).not.toBe(b.pendingKey);
  });

  it("round-trips the prefix transforms the route + validator rely on", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const { pendingKey, publicKey, storedKey } = buildAssetKeys(
      "categories",
      "webp",
      id,
    );
    expect(publicKeyFromPendingKey(pendingKey)).toBe(publicKey);
    expect(storedKeyFromPublicKey(publicKey)).toBe(storedKey);
  });
});

describe("asset-upload — parsePendingKey (validator defence-in-depth)", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("parses a well-formed pending key", () => {
    expect(parsePendingKey(`pending/products/${id}.jpg`)).toEqual({
      kind: "products",
      id,
      ext: "jpg",
    });
  });

  it("rejects keys outside the pending prefix", () => {
    expect(parsePendingKey(`uploads/products/${id}.jpg`)).toBeNull();
    expect(parsePendingKey(`products/${id}.jpg`)).toBeNull();
  });

  it("rejects an unknown kind, bad uuid, or disallowed extension", () => {
    expect(parsePendingKey(`pending/invoices/${id}.jpg`)).toBeNull();
    expect(parsePendingKey(`pending/products/not-a-uuid.jpg`)).toBeNull();
    expect(parsePendingKey(`pending/products/${id}.svg`)).toBeNull();
    expect(parsePendingKey(`pending/products/${id}.exe`)).toBeNull();
  });

  it("rejects traversal / extra path segments", () => {
    expect(parsePendingKey(`pending/products/../${id}.jpg`)).toBeNull();
    expect(parsePendingKey(`pending/products/sub/${id}.jpg`)).toBeNull();
    expect(parsePendingKey(`pending/${id}.jpg`)).toBeNull();
  });
});

describe("asset-upload — validateUploadRequest", () => {
  const MAX = 10 * 1024 * 1024;

  it("accepts a valid request and returns the resolved ext", () => {
    const r = validateUploadRequest(
      { kind: "products", contentType: "image/png", contentLength: 1024 },
      MAX,
    );
    expect(r).toEqual({ ok: true, kind: "products", ext: "png" });
  });

  it("rejects an unknown kind", () => {
    const r = validateUploadRequest(
      { kind: "widgets", contentType: "image/png", contentLength: 1024 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.field).toBe("kind");
  });

  it("rejects a disallowed content type", () => {
    const r = validateUploadRequest(
      { kind: "products", contentType: "image/svg+xml", contentLength: 1024 },
      MAX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.field).toBe("contentType");
  });

  it("rejects zero, negative, non-integer, and over-cap sizes", () => {
    for (const contentLength of [0, -5, 1.5, MAX + 1]) {
      const r = validateUploadRequest(
        { kind: "products", contentType: "image/jpeg", contentLength },
        MAX,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.field).toBe("contentLength");
    }
  });

  it("accepts a file exactly at the cap", () => {
    const r = validateUploadRequest(
      { kind: "products", contentType: "image/jpeg", contentLength: MAX },
      MAX,
    );
    expect(r.ok).toBe(true);
  });
});

describe("asset-upload — presignedPostParams", () => {
  it("pins the bucket, exact key, size range, and content type", () => {
    const params = presignedPostParams({
      bucket: "shop-assets",
      key: "pending/products/abc.jpg",
      contentType: "image/jpeg",
      maxBytes: 5_000_000,
      expiresSeconds: 300,
    });
    expect(params.Bucket).toBe("shop-assets");
    expect(params.Key).toBe("pending/products/abc.jpg");
    expect(params.Expires).toBe(300);
    expect(params.Fields["Content-Type"]).toBe("image/jpeg");
    expect(params.Conditions).toContainEqual([
      "content-length-range",
      1,
      5_000_000,
    ]);
    expect(params.Conditions).toContainEqual([
      "eq",
      "$Content-Type",
      "image/jpeg",
    ]);
  });
});

describe("asset-upload — sniffImageType (magic bytes)", () => {
  it("identifies the four allowed raster formats", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(AVIF)).toBe("image/avif");
  });

  it("returns null for spoofed / disallowed / non-image content", () => {
    expect(sniffImageType(GIF)).toBeNull();
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(TEXT)).toBeNull();
    expect(sniffImageType(head())).toBeNull(); // empty
    expect(sniffImageType(head(0xff, 0xd8))).toBeNull(); // truncated JPEG head
  });

  it("does not mistake a RIFF container that is not WEBP (e.g. WAV)", () => {
    const wav = head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"));
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe("asset-upload — uploadedBytesMatchKey", () => {
  it("accepts bytes whose true type matches the key extension", () => {
    expect(uploadedBytesMatchKey(JPEG, "jpg")).toBe(true);
    expect(uploadedBytesMatchKey(PNG, "png")).toBe(true);
    expect(uploadedBytesMatchKey(WEBP, "webp")).toBe(true);
    expect(uploadedBytesMatchKey(AVIF, "avif")).toBe(true);
  });

  it("rejects a content/extension mismatch (PNG bytes under a .jpg key)", () => {
    expect(uploadedBytesMatchKey(PNG, "jpg")).toBe(false);
    expect(uploadedBytesMatchKey(JPEG, "png")).toBe(false);
  });

  it("rejects a non-image masquerading as an image", () => {
    expect(uploadedBytesMatchKey(SVG, "jpg")).toBe(false);
    expect(uploadedBytesMatchKey(TEXT, "png")).toBe(false);
  });
});
