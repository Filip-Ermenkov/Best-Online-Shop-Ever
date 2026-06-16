import type { MetadataRoute } from "next";

/**
 * `/robots.txt` — Next.js metadata route.
 *
 * Three things:
 *
 *  1. **Crawl scope for search engines.** Catalog is open; private and utility
 *     routes are disallowed — `/account`, `/admin`, `/checkout`, `/cart`,
 *     `/search` (a faceted-query crawl trap of no index value), and `/track`
 *     (guest capability-token URLs — already `noindex` + `no-referrer` at the
 *     page, disallowed here too as defence-in-depth and to save crawl budget).
 *
 *  2. **AI-crawler policy (2026).** The current e-commerce consensus is to BLOCK
 *     training/bulk crawlers while ALLOWING search/retrieval bots, so the shop
 *     still appears in AI answers (with citations → referral traffic) but its
 *     content is not vacuumed for model training. The downside of blocking
 *     training bots is near-zero — they send almost no referrals (GPTBot ≈
 *     1,255:1 crawl-to-refer, ClaudeBot ≈ 20,583:1) while costing real Lambda
 *     invocations and bandwidth, so this is a cost optimisation as much as a
 *     content one. Allowed (they fall under `*`): Googlebot, Bingbot,
 *     OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-Web, Applebot.
 *     The owner can flip this stance by editing one list. Note: robots.txt is a
 *     request, not a fence — aggressive scrapers ignore it; WAF rate-limiting
 *     (infra/, opt-in) is the enforcement layer.
 *
 *  3. **Sitemap + host pointers** for discovery + canonical host.
 *
 * Non-production hosts (localhost / a non-https base) return a blanket
 * `Disallow: /` so preview/dev deployments never land in an index.
 */

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "http://localhost:3000";

/** Index only on a real production host — keep dev/preview out of search results. */
const isProductionSite =
  SITE_URL.startsWith("https://") && !SITE_URL.includes("localhost");

/** Private / no-index-value routes, disallowed for every crawler. */
const DISALLOWED_PATHS = [
  "/account",
  "/admin",
  "/checkout",
  "/cart",
  "/search",
  "/track",
  "/api",
];

/**
 * Training / bulk AI crawlers — fully disallowed. (Search/retrieval bots that
 * drive referral traffic are deliberately absent; they follow the `*` rule.)
 * `Applebot-Extended` opts out of Apple AI training while plain `Applebot`
 * (search) stays allowed; `Google-Extended` opts out of Gemini training while
 * `Googlebot` (search) stays allowed.
 */
const AI_TRAINING_CRAWLERS = [
  "GPTBot",
  "CCBot",
  "Google-Extended",
  "anthropic-ai",
  "ClaudeBot",
  "Applebot-Extended",
  "Bytespider",
  "Meta-ExternalAgent",
  "FacebookBot",
  "cohere-ai",
  "Diffbot",
  "Omgilibot",
  "ImagesiftBot",
  "PetalBot",
];

export default function robots(): MetadataRoute.Robots {
  if (!isProductionSite) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [
      // Search engines + allowed AI search/retrieval bots: catalog open, private
      // routes closed.
      { userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS },
      // Training / bulk AI crawlers: blocked entirely.
      { userAgent: AI_TRAINING_CRAWLERS, disallow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
