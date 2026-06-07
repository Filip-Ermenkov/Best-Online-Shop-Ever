/**
 * Builds the AWS Lambda deployment bundle into ./dist:
 *
 *   dist/handler.js          — esbuild bundle of src/handler.ts + every pure-JS
 *                              dependency (Hono, Drizzle, pg, pino, @shop/*).
 *   dist/node_modules/argon2 — the ONE native dependency, installed unbundled
 *                              for the build platform.
 *
 * Terraform's data.archive_file zips ./dist; the Lambda handler is "handler.handler".
 *
 * NATIVE DEPENDENCY — READ THIS:
 *   argon2 ships a compiled .node binary, so the build platform's OS+arch must
 *   match the Lambda's. The infra default is arm64, so build on an arm64 Linux
 *   box (GitHub's `ubuntu-24.04-arm` runner) — or set infra var
 *   lambda_architecture = "x86_64" and build on a normal x64 Linux runner.
 *   @aws-sdk/* is provided by the Node 22 Lambda runtime, so it stays external
 *   and is NOT shipped.
 */
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Pin the shipped argon2 to the exact version @shop/auth depends on.
const argon2Spec = JSON.parse(
  readFileSync(join(root, "..", "auth", "package.json"), "utf8"),
).dependencies.argon2;

await build({
  entryPoints: [join(root, "src", "handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "handler.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // argon2  → native, shipped via the npm install below.
  // @aws-sdk → provided by the Lambda runtime.
  // pg-native → optional native accelerator we don't use.
  external: ["argon2", "@aws-sdk/*", "pg-native"],
  logLevel: "info",
});

// Self-contained dist package; ship argon2 (+ its runtime deps) only.
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify({ name: "shop-api-lambda", version: "0.0.0", private: true }, null, 2) + "\n",
);

execSync(
  `npm install "argon2@${argon2Spec}" --prefix "${dist}" --omit=dev --no-package-lock --no-audit --no-fund`,
  { stdio: "inherit" },
);

console.log("\nLambda bundle ready in backend/shop-api/dist/ — `terraform apply` will zip it.");
