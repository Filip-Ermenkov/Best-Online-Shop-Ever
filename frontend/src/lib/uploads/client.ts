/**
 * Browser-side client for the admin image-upload pipeline (`/admin/uploads/*`
 * on shop-api — see backend routes/admin/uploads.ts), roadmap item 46.
 *
 * The flow is two hops, by design (the bytes never pass through our Lambda):
 *
 *   1. POST /admin/uploads (with the admin cookie) → a presigned POST policy.
 *   2. POST the file straight to S3 with that policy → 204. The bytes land in
 *      `pending/`, where the assets-fn validator magic-byte-checks them and
 *      promotes a genuine image to the served prefix.
 *
 * `uploadImage(file, kind)` runs both hops and returns the `storedKey` to save
 * on the entity. `waitUntilReady(key)` optionally polls until the validator has
 * promoted the object (so the editor can show the real image, not a placeholder,
 * before saving). Same transport posture as lib/admin/categories/client.ts:
 * plain `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"`
 * on OUR endpoints — but NOT on the S3 hop, which is authorised by the policy,
 * not the cookie.
 */
import type {
  AdminPresignedUpload,
  AdminUploadStatus,
  UploadError,
  UploadKind,
  UploadResult,
  UploadedImage,
} from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

async function readProblem(res: Response): Promise<ProblemResponse | undefined> {
  try {
    return (await res.json()) as ProblemResponse;
  } catch {
    return undefined;
  }
}

function classifyError(status: number, problem?: ProblemResponse): UploadError {
  if (status === 404) return { kind: "not_admin" };
  if (status === 503) return { kind: "not_configured" };
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

/** Hop 1: ask the API for a presigned POST for this file. */
export async function requestPresignedUpload(
  kind: UploadKind,
  file: { type: string; size: number },
): Promise<UploadResult<AdminPresignedUpload>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/admin/uploads`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        contentType: file.type,
        contentLength: file.size,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: "network", detail: (err as Error)?.message },
    };
  }
  if (!res.ok) {
    return { ok: false, error: classifyError(res.status, await readProblem(res)) };
  }
  return { ok: true, value: (await res.json()) as AdminPresignedUpload };
}

/** Hop 2: POST the file straight to S3 using the presigned policy. */
async function postToS3(
  presign: AdminPresignedUpload,
  file: Blob,
): Promise<UploadResult<void>> {
  const form = new FormData();
  // The policy fields MUST precede the file part; S3 ignores anything after it.
  for (const [name, value] of Object.entries(presign.fields)) {
    form.append(name, value);
  }
  form.append("file", file);

  let res: Response;
  try {
    res = await fetch(presign.url, { method: "POST", body: form });
  } catch (err) {
    return {
      ok: false,
      error: { kind: "network", detail: (err as Error)?.message },
    };
  }
  // S3 returns 204 (or 201 if success_action_status is set) on success.
  if (!res.ok && res.status !== 204) {
    return { ok: false, error: { kind: "s3_rejected", status: res.status } };
  }
  return { ok: true, value: undefined };
}

/**
 * Run both hops. Returns the key to persist on the entity. The object may take a
 * moment to appear at `publicUrl` (the validator runs asynchronously) — call
 * `waitUntilReady(storedKey)` first if the editor wants to preview it.
 */
export async function uploadImage(
  file: File,
  kind: UploadKind,
): Promise<UploadResult<UploadedImage>> {
  const presigned = await requestPresignedUpload(kind, file);
  if (!presigned.ok) return presigned;

  const sent = await postToS3(presigned.value, file);
  if (!sent.ok) return sent;

  return {
    ok: true,
    value: {
      storedKey: presigned.value.storedKey,
      publicUrl: presigned.value.publicUrl,
    },
  };
}

/** Poll GET /admin/uploads/status once. */
export async function getUploadStatus(
  key: string,
): Promise<UploadResult<AdminUploadStatus>> {
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl}/admin/uploads/status?key=${encodeURIComponent(key)}`,
      { credentials: "include", headers: { Accept: "application/json" } },
    );
  } catch (err) {
    return {
      ok: false,
      error: { kind: "network", detail: (err as Error)?.message },
    };
  }
  if (!res.ok) {
    return { ok: false, error: classifyError(res.status, await readProblem(res)) };
  }
  return { ok: true, value: (await res.json()) as AdminUploadStatus };
}

/**
 * Poll until the validator has promoted the object (it is then servable at its
 * CDN URL), or give up. Defaults: ~10s of polling at 1s intervals — comfortably
 * longer than the validator's typical sub-second turnaround.
 */
export async function waitUntilReady(
  key: string,
  opts: { tries?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const tries = opts.tries ?? 10;
  const intervalMs = opts.intervalMs ?? 1000;
  for (let i = 0; i < tries; i++) {
    const status = await getUploadStatus(key);
    if (status.ok && status.value.ready) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
