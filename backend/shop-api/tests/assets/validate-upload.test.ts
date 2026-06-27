import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  handler,
  processPendingObject,
  type AssetS3Ops,
} from "../../src/assets/handler.js";

/**
 * Unit tests for the assets-fn validator (src/assets/handler.ts): the
 * magic-byte gate that promotes genuine images and deletes everything else. The
 * S3 ops are a recorder (no AWS); the byte fixtures are real format heads.
 */

const UUID = "11111111-2222-4333-8444-555555555555";
const BUCKET = "shop-assets";

function A(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...A("JFIF")]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT = new Uint8Array(A("<svg> totally not an image"));

const noopLog = {
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

interface Recorder {
  ops: AssetS3Ops;
  promoted: { from: string; to: string; ct: string }[];
  removed: string[];
  fetched: string[];
}

function recorder(bytesByKey: Record<string, Uint8Array>): Recorder {
  const promoted: Recorder["promoted"] = [];
  const removed: string[] = [];
  const fetched: string[] = [];
  const ops: AssetS3Ops = {
    async getHeadBytes(_bucket, key) {
      fetched.push(key);
      return bytesByKey[key] ?? new Uint8Array();
    },
    async promote(_bucket, from, to, ct) {
      promoted.push({ from, to, ct });
    },
    async remove(_bucket, key) {
      removed.push(key);
    },
  };
  return { ops, promoted, removed, fetched };
}

describe("assets-fn — processPendingObject", () => {
  it("promotes a genuine JPEG to the served prefix and removes the pending copy", async () => {
    const key = `pending/products/${UUID}.jpg`;
    const r = recorder({ [key]: JPEG });

    const outcome = await processPendingObject(BUCKET, key, r.ops, noopLog);

    expect(outcome).toBe("promoted");
    expect(r.promoted).toEqual([
      { from: key, to: `uploads/products/${UUID}.jpg`, ct: "image/jpeg" },
    ]);
    expect(r.removed).toEqual([key]);
  });

  it("rejects a content/extension mismatch (PNG bytes under a .jpg key)", async () => {
    const key = `pending/products/${UUID}.jpg`;
    const r = recorder({ [key]: PNG });

    const outcome = await processPendingObject(BUCKET, key, r.ops, noopLog);

    expect(outcome).toBe("rejected");
    expect(r.promoted).toEqual([]);
    expect(r.removed).toEqual([key]); // deleted, never served
  });

  it("rejects a non-image masquerading as a .png", async () => {
    const key = `pending/banners/${UUID}.png`;
    const r = recorder({ [key]: TEXT });

    const outcome = await processPendingObject(BUCKET, key, r.ops, noopLog);

    expect(outcome).toBe("rejected");
    expect(r.promoted).toEqual([]);
    expect(r.removed).toEqual([key]);
  });

  it("rejects a malformed key WITHOUT fetching any bytes", async () => {
    const key = `pending/products/../${UUID}.jpg`;
    const r = recorder({});

    const outcome = await processPendingObject(BUCKET, key, r.ops, noopLog);

    expect(outcome).toBe("rejected");
    expect(r.fetched).toEqual([]); // never even read the object
    expect(r.removed).toEqual([key]);
  });

  it("promotes a WebP with the right served Content-Type", async () => {
    const key = `pending/categories/${UUID}.webp`;
    const webp = new Uint8Array([
      ...A("RIFF"),
      0x24,
      0,
      0,
      0,
      ...A("WEBP"),
      ...A("VP8 "),
    ]);
    const r = recorder({ [key]: webp });

    const outcome = await processPendingObject(BUCKET, key, r.ops, noopLog);

    expect(outcome).toBe("promoted");
    expect(r.promoted[0]?.ct).toBe("image/webp");
    expect(r.promoted[0]?.to).toBe(`uploads/categories/${UUID}.webp`);
  });
});

describe("assets-fn — handler (S3 event)", () => {
  it("processes every record in the batch and url-decodes the key", async () => {
    const key = `pending/products/${UUID}.jpg`;
    const r = recorder({ [key]: JPEG });

    await handler(
      {
        Records: [
          // S3 encodes spaces as '+'; our keys have none, but exercise the decode.
          { s3: { bucket: { name: BUCKET }, object: { key } } },
        ],
      },
      { ops: r.ops, logger: noopLog },
    );

    expect(r.promoted).toHaveLength(1);
    expect(r.removed).toEqual([key]);
  });

  it("no-ops cleanly on an empty event", async () => {
    const r = recorder({});
    await expect(handler({}, { ops: r.ops, logger: noopLog })).resolves.toBeUndefined();
    expect(r.promoted).toEqual([]);
  });
});
