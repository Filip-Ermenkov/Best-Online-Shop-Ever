import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Logger } from "pino";
import {
  contentTypeForExt,
  parsePendingKey,
  publicKeyFromPendingKey,
  uploadedBytesMatchKey,
} from "../lib/asset-upload.js";
import { logger as baseLogger } from "../lib/logger.js";

/**
 * assets-fn — the validation half of the image-upload pipeline (ARCHITECTURE
 * §3.6, §13; roadmap item 46). A tiny, single-purpose Lambda triggered by
 * `s3:ObjectCreated:*` under the bucket's `pending/` prefix (infra/assets.tf).
 *
 * Why it exists: the presigned POST (routes/admin/uploads.ts) constrains the
 * upload's declared size and Content-Type, but a declared MIME is not proof of
 * content — a `.jpg` can carry an HTML/JS polyglot, an SVG, or an executable.
 * This function reads the object's leading bytes and re-derives the TRUE type
 * from its magic number (lib/asset-upload.ts, the same allowlist the presign
 * uses). Only a genuine, allowlisted raster image whose bytes match its key's
 * extension is **promoted** to the CDN-served `uploads/` prefix; everything else
 * is **deleted**. So an attacker who somehow obtains a presigned POST still
 * cannot leave servable hostile content in the bucket.
 *
 * Failure model: a "rejected" object (bad bytes) is a SUCCESSFUL delete, not an
 * error. Only an unexpected S3 fault throws — the async S3 invoke then retries,
 * and a persistently failing record lands on the function's error alarm
 * (infra/assets.tf). The validator is idempotent: a re-delivered event for a key
 * already promoted+removed simply finds nothing to fetch and no-ops on delete.
 *
 * Pure-JS bundle (build-assets.mjs → dist-assets/, like email-fn / scheduler-fn):
 * the import graph is the magic-byte helper + the AWS SDK only, no argon2.
 */

// Minimal local shape of the S3 notification event — avoids an @types/aws-lambda
// dependency for the two fields we read.
interface S3EventRecord {
  s3: { bucket: { name: string }; object: { key: string; size?: number } };
}
interface S3Event {
  Records?: S3EventRecord[];
}

/** The three S3 operations the validator performs — injectable for tests. */
export interface AssetS3Ops {
  /** Read the first `length` bytes of an object (a ranged GET — never the whole file). */
  getHeadBytes(bucket: string, key: string, length: number): Promise<Uint8Array>;
  /** Copy a validated object to its served key with a long-cache Content-Type. */
  promote(
    bucket: string,
    fromKey: string,
    toKey: string,
    contentType: string,
  ): Promise<void>;
  /** Delete an object (the rejected-content path, and the post-promote cleanup). */
  remove(bucket: string, key: string): Promise<void>;
}

/** Only the leading bytes are needed for a magic-number check. */
const HEAD_BYTES = 64;

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  s3Client ??= new S3Client({});
  return s3Client;
}

/** Production S3 ops. Region comes from the Lambda's AWS_REGION env. */
const defaultOps: AssetS3Ops = {
  async getHeadBytes(bucket, key, length) {
    const res = await getS3().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    if (!res.Body) return new Uint8Array();
    // SDK v3 stream helper — returns the (ranged) body as bytes.
    return (
      res.Body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
  },
  async promote(bucket, fromKey, toKey, contentType) {
    await getS3().send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: encodeURI(`${bucket}/${fromKey}`),
        Key: toKey,
        ContentType: contentType,
        // The bytes are immutable (the key is a content-addressed UUID), so the
        // CDN can cache them forever.
        CacheControl: "public, max-age=31536000, immutable",
        MetadataDirective: "REPLACE",
      }),
    );
  },
  async remove(bucket, key) {
    await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};

export type RecordOutcome = "promoted" | "rejected";

/**
 * Validate one pending object. Pure orchestration over the injected ops + the
 * pure magic-byte helper, so it unit-tests without AWS.
 */
export async function processPendingObject(
  bucket: string,
  key: string,
  ops: AssetS3Ops,
  log: Logger,
): Promise<RecordOutcome> {
  // Defence in depth: only a key matching the exact mint shape is processed.
  const parsed = parsePendingKey(key);
  if (!parsed) {
    await ops.remove(bucket, key);
    log.warn({ key, reason: "malformed_key" }, "asset_rejected");
    return "rejected";
  }

  const bytes = await ops.getHeadBytes(bucket, key, HEAD_BYTES);
  if (!uploadedBytesMatchKey(bytes, parsed.ext)) {
    await ops.remove(bucket, key);
    log.warn(
      { key, kind: parsed.kind, ext: parsed.ext, reason: "content_mismatch" },
      "asset_rejected",
    );
    return "rejected";
  }

  const publicKey = publicKeyFromPendingKey(key);
  const contentType = contentTypeForExt(parsed.ext)!;
  await ops.promote(bucket, key, publicKey, contentType);
  await ops.remove(bucket, key);
  log.info(
    { fromKey: key, toKey: publicKey, kind: parsed.kind },
    "asset_promoted",
  );
  return "promoted";
}

/** S3 event keys are URL-encoded (spaces as `+`). Decode before use. */
function decodeKey(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, " "));
}

export interface HandlerDeps {
  ops?: AssetS3Ops;
  logger?: Logger;
}

/**
 * Lambda entry point. Processes every record in the S3 notification batch. A
 * rejected object is handled (deleted) and does NOT throw; an unexpected fault
 * propagates so the async invoke retries and ultimately alarms.
 */
export async function handler(
  event: S3Event,
  deps: HandlerDeps = {},
): Promise<void> {
  const ops = deps.ops ?? defaultOps;
  const log = deps.logger ?? baseLogger;
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeKey(record.s3.object.key);
    await processPendingObject(bucket, key, ops, log);
  }
}

/** Test-only: drop the cached S3 client. */
export function _resetS3ClientForTests(): void {
  s3Client = null;
}
