/**
 * Builds the scheduler-fn AWS Lambda bundle into ./dist-scheduler:
 *
 *   dist-scheduler/handler.js — esbuild bundle of src/jobs/handler.ts.
 *
 * Terraform's data.archive_file zips ./dist-scheduler (infra/scheduler.tf);
 * the Lambda handler is "handler.handler". Unlike the shop-api HTTP bundle
 * (build.mjs) there is no native-dependency step — the jobs' import graph
 * deliberately avoids argon2 (no session/password code), so this bundle is
 * pure JS and builds on any OS, exactly like email-fn's. @aws-sdk/* is
 * provided by the Node 22 Lambda runtime and stays external.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist-scheduler");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "jobs", "handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "handler.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // @aws-sdk → Lambda runtime. pg-native → unused optional accelerator.
  // argon2 listed defensively: if a future refactor drags session/password
  // code into the jobs graph, the build keeps working and the require fails
  // at RUNTIME with a clear module-not-found — treat that as a signal to cut
  // the import, not to ship the native binary.
  external: ["@aws-sdk/*", "pg-native", "argon2"],
  logLevel: "info",
});

// No "type" field → Lambda treats handler.js as CommonJS, matching the
// esbuild output above (same convention as build.mjs / email's build.mjs).
writeFileSync(
  join(dist, "package.json"),
  JSON.stringify(
    { name: "scheduler-fn-lambda", version: "0.0.0", private: true },
    null,
    2,
  ) + "\n",
);

console.log(
  "\nscheduler-fn bundle ready in backend/shop-api/dist-scheduler/ — `terraform apply` will zip it.",
);
