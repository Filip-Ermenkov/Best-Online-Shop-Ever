/**
 * Builds the assets-fn AWS Lambda bundle into ./dist-assets:
 *
 *   dist-assets/handler.js — esbuild bundle of src/assets/handler.ts.
 *
 * Terraform's data.archive_file zips ./dist-assets (infra/assets.tf); the Lambda
 * handler is "handler.handler". Like email-fn / scheduler-fn this is a pure-JS
 * bundle — the import graph is the magic-byte helper (lib/asset-upload.ts) plus
 * the AWS SDK, no argon2 — so it builds on any OS. @aws-sdk/* is provided by the
 * Node 22 Lambda runtime and stays external.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist-assets");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "assets", "handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "handler.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // @aws-sdk → Lambda runtime. pg-native → unused optional accelerator. argon2
  // listed defensively (see build-scheduler.mjs): the assets graph must never
  // drag in session/password code; if it ever does, the require fails at RUNTIME
  // with a clear module-not-found — a signal to cut the import, not ship a binary.
  external: ["@aws-sdk/*", "pg-native", "argon2"],
  logLevel: "info",
});

// No "type" field → Lambda treats handler.js as CommonJS, matching the esbuild
// output above (same convention as build.mjs / build-scheduler.mjs).
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify(
    { name: "assets-fn-lambda", version: "0.0.0", private: true },
    null,
    2,
  ) + "\n",
);

console.log(
  "\nassets-fn bundle ready in backend/shop-api/dist-assets/ — `terraform apply` will zip it.",
);
