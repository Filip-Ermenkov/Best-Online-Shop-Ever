import { parseEnv } from "./env.js";

/**
 * The DB stores S3 keys (e.g. "products/abc/main.jpg"). The public URL is
 * always derived at the edge: a CloudFront distribution sits in front of the
 * private S3 bucket and serves transformed/cached versions.
 *
 * We deliberately do NOT store fully-qualified URLs in the DB:
 *   - the CDN domain may change (custom domain rollout, region migration),
 *   - the bucket might be private (signed URLs, rotated keys),
 *   - it's an extra denormalisation to maintain.
 *
 * If CDN_BASE_URL is empty (early dev / tests), we return a placehold.co URL
 * so the frontend keeps rendering something rather than broken images.
 */
export function buildImageUrl(s3Key: string): string {
  const env = parseEnv();
  const base = env.CDN_BASE_URL;
  if (!base) {
    const label = encodeURIComponent(
      s3Key.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ?? "image",
    );
    return `https://placehold.co/600x600/e2e8f0/475569?text=${label}`;
  }
  // s3Key has no leading slash by convention; base has trailing slashes stripped.
  return `${base}/${s3Key.replace(/^\/+/, "")}`;
}
