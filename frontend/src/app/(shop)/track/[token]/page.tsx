import type { Metadata } from "next";
import { TrackView } from "@/components/shop/TrackView";

/**
 * Public guest order-tracking page — the capability URL from the order email
 * (`docs/README.md` §7 "Проследяване на поръчка").
 *
 * `robots: noindex/nofollow` and `referrer: no-referrer` are deliberate: the
 * token in the URL is a bearer credential, so the page must never be indexed
 * and must never leak the token to third parties via the Referer header
 * (W3C capability-URL guidance). The page itself loads no third-party
 * resources, and the strict CSP from the proxy is also in force.
 */
export const metadata: Metadata = {
  title: "Проследяване на поръчка",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// A capability page must never be statically cached, and forcing dynamic
// rendering also keeps the client-side `useSearchParams()` (the ?confirm=1
// banner) out of any prerender/Suspense requirement.
export const dynamic = "force-dynamic";

export default async function TrackPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TrackView token={token} />;
}
