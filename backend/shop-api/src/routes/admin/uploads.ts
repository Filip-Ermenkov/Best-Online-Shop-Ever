import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import {
  ASSET_KINDS,
  PUBLIC_PREFIX,
  buildAssetKeys,
  parsePendingKey,
  presignedPostParams,
  validateUploadRequest,
  type PresignedPostParams,
} from "../../lib/asset-upload.js";
import { parseEnv } from "../../lib/env.js";
import { ApiError, ProblemSchema, badRequest } from "../../lib/errors.js";
import { buildImageUrl } from "../../lib/images.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin image-upload pipeline — the presign side (ARCHITECTURE §3.6, §13;
 * roadmap item 46). The keystone the catalog has been waiting on: until now
 * products / categories / banners stored S3 keys that pointed at nothing,
 * because no entity had a way to put bytes in the bucket. This route mints a
 * short-lived presigned **POST** so the browser uploads straight to S3 (never
 * through Lambda — a 6 MB sync payload cap and a pay-per-byte cost we sidestep),
 * with the policy pinning the exact key, a `content-length-range`, and the
 * `Content-Type`. The bytes land in `pending/`; an S3 event then runs the
 * `assets-fn` validator (assets/handler.ts), which magic-byte-checks the real
 * content and promotes only true images to the CDN-served `uploads/` prefix.
 *
 * Built once, it serves all three image-bearing entities uniformly (the `kind`
 * field selects the key folder). The admin saves the returned `storedKey` on the
 * product/category/banner exactly as the categories + products slices already
 * accept image keys.
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   POST /admin/uploads          mint a presigned POST for one image
 *   GET  /admin/uploads/status   has the validator promoted a key yet? (poll)
 *
 * No DB writes (minting a URL is not a state change to a catalog entity, so
 * there is no `admin_audit_log` row — the audit trail captures the PATCH that
 * actually attaches the image). No migration. The route is inert until
 * `ASSET_UPLOAD_BUCKET` is configured (a clean 503, mirroring how the
 * catalog-backup job fails loud rather than silently no-op'ing).
 */

type AdminUploadsVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminUploadsRoutes = new OpenAPIHono<{
  Variables: AdminUploadsVariables;
}>({
  defaultHook: validationHook,
});

adminUploadsRoutes.use("*", requireAdmin);

// ─── S3 adapters (injectable — same DI posture as the catalog-backup job) ─────
//
// The presign and the HEAD are the only two AWS touchpoints. They are swappable
// so the integration tests exercise the full route wiring (validation, 503,
// requireAdmin, response shape) without AWS creds or network; the REAL presign
// policy is proven separately by the pure `presignedPostParams` unit test and an
// offline `createPresignedPost` check.

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}
export type PresignPostFn = (params: PresignedPostParams) => Promise<PresignedPost>;
export type ObjectExistsFn = (bucket: string, key: string) => Promise<boolean>;

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  const env = parseEnv();
  s3Client ??= new S3Client({ region: env.ASSET_AWS_REGION });
  return s3Client;
}

let presignPost: PresignPostFn = (params) =>
  createPresignedPost(
    getS3(),
    params as Parameters<typeof createPresignedPost>[1],
  );

let objectExists: ObjectExistsFn = async (bucket, key) => {
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NotFoundException") {
      return false;
    }
    throw err;
  }
};

/** Test seam: override the S3 adapters. */
export function _setUploadAdaptersForTests(a: {
  presignPost?: PresignPostFn;
  objectExists?: ObjectExistsFn;
}): void {
  if (a.presignPost) presignPost = a.presignPost;
  if (a.objectExists) objectExists = a.objectExists;
}
export function _resetUploadAdaptersForTests(): void {
  presignPost = (params) =>
    createPresignedPost(
      getS3(),
      params as Parameters<typeof createPresignedPost>[1],
    );
  objectExists = async (bucket, key) => {
    try {
      await getS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === "NotFound" || name === "NotFoundException") {
        return false;
      }
      throw err;
    }
  };
  s3Client = null;
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

const UploadRequestSchema = z
  .object({
    /** Which image-bearing entity the upload is for (selects the key folder). */
    kind: z.enum(["products", "categories", "banners"]),
    /** The browser-declared MIME — scopes the presign; never trusted as proof. */
    contentType: z.string().min(1).max(100),
    /** Byte size of the file the browser is about to upload. */
    contentLength: z.number().int().positive(),
  })
  .strict()
  .openapi("AdminUploadRequest");

export type AdminPresignedUpload = {
  /** The S3 endpoint the browser POSTs the multipart form to. */
  url: string;
  /** Always POST — included so the client never hard-codes the verb. */
  method: "POST";
  /**
   * The exact multipart form fields to send alongside the file (policy,
   * signature, key, Content-Type, …). Send the file as the LAST `file` field.
   */
  fields: Record<string, string>;
  /** The key to save on the entity once the upload is validated + promoted. */
  storedKey: string;
  /** The eventual CDN URL the stored key resolves to (a placeholder until live). */
  publicUrl: string;
  /** Seconds until the presigned POST expires. */
  expiresInSeconds: number;
};

const PresignedUploadSchema = z
  .object({
    url: z.string().url(),
    method: z.literal("POST"),
    fields: z.record(z.string(), z.string()),
    storedKey: z.string(),
    publicUrl: z.string(),
    expiresInSeconds: z.number().int(),
  })
  .openapi("AdminPresignedUpload");

export type AdminUploadStatus = { key: string; ready: boolean };

const UploadStatusSchema = z
  .object({
    key: z.string(),
    /** True once the validator has promoted the object to the served prefix. */
    ready: z.boolean(),
  })
  .openapi("AdminUploadStatus");

const StatusQuerySchema = z.object({
  /** The `storedKey` returned by POST /admin/uploads (e.g. `products/<uuid>.jpg`). */
  key: z.string().min(1).max(256),
});

function uploadsNotConfigured(): ApiError {
  return new ApiError({
    type: "/problems/uploads-not-configured",
    title: "Uploads Not Configured",
    status: 503,
    detail:
      "Image uploads are not available: no asset bucket is configured for this deployment.",
  });
}

// ─── POST /admin/uploads ──────────────────────────────────────────────────────

const presignRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["admin-uploads"],
  summary: "Mint a presigned POST for one catalog image upload",
  request: {
    body: { content: { "application/json": { schema: UploadRequestSchema } } },
  },
  responses: {
    201: {
      description: "The presigned POST target + fields and the key to store.",
      content: { "application/json": { schema: PresignedUploadSchema } },
    },
    400: {
      description: "Disallowed type, bad size, or unknown kind.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "`/problems/uploads-not-configured` — no asset bucket set.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminUploadsRoutes.openapi(presignRoute, async (c) => {
  const env = parseEnv();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");

  if (env.ASSET_UPLOAD_BUCKET.length === 0) throw uploadsNotConfigured();

  const result = validateUploadRequest(
    {
      kind: body.kind,
      contentType: body.contentType,
      contentLength: body.contentLength,
    },
    env.ASSET_UPLOAD_MAX_BYTES,
  );
  if (!result.ok) {
    throw badRequest(result.problem.message, [
      { path: result.problem.field, message: result.problem.message },
    ]);
  }

  const keys = buildAssetKeys(result.kind, result.ext);
  const { url, fields } = await presignPost(
    presignedPostParams({
      bucket: env.ASSET_UPLOAD_BUCKET,
      key: keys.pendingKey,
      contentType: body.contentType,
      maxBytes: env.ASSET_UPLOAD_MAX_BYTES,
      expiresSeconds: env.ASSET_UPLOAD_URL_TTL_SECONDS,
    }),
  );

  // Field NAMES only — there is no PII in an upload request, but stay consistent
  // with the structured-audit convention (never log the signature/policy).
  log.info(
    { kind: result.kind, storedKey: keys.storedKey, adminId: admin.id },
    "upload_presigned",
  );

  const payload: AdminPresignedUpload = {
    url,
    method: "POST",
    fields,
    storedKey: keys.storedKey,
    publicUrl: buildImageUrl(keys.storedKey),
    expiresInSeconds: env.ASSET_UPLOAD_URL_TTL_SECONDS,
  };
  return c.json(payload, 201);
});

// ─── GET /admin/uploads/status ────────────────────────────────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["admin-uploads"],
  summary: "Has the uploaded key been validated and promoted yet?",
  request: { query: StatusQuerySchema },
  responses: {
    200: {
      description: "Whether the served object exists yet.",
      content: { "application/json": { schema: UploadStatusSchema } },
    },
    400: {
      description: "Malformed key.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "`/problems/uploads-not-configured` — no asset bucket set.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminUploadsRoutes.openapi(statusRoute, async (c) => {
  const env = parseEnv();
  const { key } = c.req.valid("query");

  if (env.ASSET_UPLOAD_BUCKET.length === 0) throw uploadsNotConfigured();

  // The status key is a STORED key (`<kind>/<uuid>.<ext>`). Validate it by the
  // same strict parser the validator uses (prefixing the pending marker), so a
  // caller can only probe keys in our own namespace — never an arbitrary object.
  if (parsePendingKey(`pending/${key}`) === null) {
    throw badRequest("Malformed upload key.", [
      { path: "key", message: "Not a recognised upload key." },
    ]);
  }

  const ready = await objectExists(
    env.ASSET_UPLOAD_BUCKET,
    `${PUBLIC_PREFIX}${key}`,
  );
  const payload: AdminUploadStatus = { key, ready };
  return c.json(payload, 200);
});

// Re-exported so app.ts can advertise the allowed kinds in logs/diagnostics if
// it ever wants to; keeps the enum single-sourced in lib/asset-upload.ts.
export { ASSET_KINDS };
