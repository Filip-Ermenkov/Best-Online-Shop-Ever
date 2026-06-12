/**
 * Builds the email-fn AWS Lambda bundle into ./dist:
 *
 *   dist/handler.js — esbuild bundle of src/queue/handler.ts.
 *
 * Terraform's data.archive_file zips ./dist (infra/email-fn.tf); the Lambda
 * handler is "handler.handler". Unlike shop-api's build there is no native
 * dependency step — this bundle is pure JS, and @aws-sdk/* is provided by
 * the Node 22 Lambda runtime so it stays external and is NOT shipped.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "queue", "handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "handler.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["@aws-sdk/*"],
  logLevel: "info",
});

// No "type" field → Lambda treats handler.js as CommonJS, matching the
// esbuild output above (same convention as backend/shop-api/build.mjs).
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify({ name: "email-fn-lambda", version: "0.0.0", private: true }, null, 2) + "\n",
);

console.log("\nemail-fn bundle ready in backend/email/dist/ — `terraform apply` will zip it.");
