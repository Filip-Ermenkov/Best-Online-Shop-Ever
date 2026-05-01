/**
 * Local development entry point. NOT used in Lambda.
 *
 *   npm run dev   → tsx watch src/server.ts (hot reload on file change)
 *   npm start     → tsx src/server.ts        (single process, no watcher)
 *
 * Production runs Hono via the Lambda adapter — see src/handler.ts.
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { parseEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";

const env = parseEnv();
const app = buildApp();

const server = serve(
  { fetch: app.fetch, port: env.PORT, hostname: "127.0.0.1" },
  (info) => {
    logger.info(
      { port: info.port, address: info.address },
      `shop-api listening on http://127.0.0.1:${info.port}`,
    );
  },
);

// Graceful shutdown — drain in-flight requests, then exit. Important for
// docker-compose / CI runs where SIGTERM is the standard stop signal.
function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "shutdown_initiated");
  server.close(() => {
    logger.info("shutdown_complete");
    process.exit(0);
  });
  // Hard exit after 8 seconds if drain hangs.
  setTimeout(() => {
    logger.warn("shutdown_force_exit");
    process.exit(1);
  }, 8_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
