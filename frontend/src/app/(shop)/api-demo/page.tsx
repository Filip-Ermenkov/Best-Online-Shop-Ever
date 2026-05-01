import Link from "next/link";
import { fetchProducts, fetchProductBySlug, ApiClientError } from "@/lib/api";

/**
 * End-to-end proof that the typed Hono RPC client talks to shop-api.
 *
 * Runs as a Next.js 16 Server Component — `fetch` happens on the Node server
 * during render, never in the browser. The `next.revalidate: 300` on the API
 * client matches the API's `Cache-Control: s-maxage=300`, so Next.js caches
 * the response for 5 minutes per route.
 *
 * Visit this page with `npm run api:dev` running in another terminal:
 *
 *   http://localhost:3000/api-demo
 *
 * The `priceCents` integer is rendered through Intl.NumberFormat, which is
 * the right way to handle money in JS (no float math, locale-aware).
 */
export const dynamic = "force-dynamic"; // always render fresh during local dev

const formatEur = new Intl.NumberFormat("bg-BG", {
  style: "currency",
  currency: "EUR",
});

export default async function ApiDemoPage() {
  let page: Awaited<ReturnType<typeof fetchProducts>> | null = null;
  let demoSingle: Awaited<ReturnType<typeof fetchProductBySlug>> | null = null;
  let error: string | null = null;

  try {
    page = await fetchProducts({ sort: "featured", limit: 12 });
    if (page.items.length > 0) {
      demoSingle = await fetchProductBySlug(page.items[0]!.slug);
    }
  } catch (err) {
    error =
      err instanceof ApiClientError
        ? `${err.message}\n${err.problem?.detail ?? ""}`
        : err instanceof Error
          ? err.message
          : "unknown error";
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-bold mb-2">shop-api smoke test</h1>
        <p className="text-sm text-muted-foreground">
          This page calls{" "}
          <code className="font-mono">GET /products</code> and{" "}
          <code className="font-mono">GET /products/:slug</code> from the real
          API via the type-safe Hono RPC client.
        </p>
      </header>

      {error && (
        <section className="rounded-md border border-red-300 bg-red-50 p-4">
          <h2 className="font-semibold text-red-800">API request failed</h2>
          <pre className="mt-2 whitespace-pre-wrap text-sm text-red-900">
            {error}
          </pre>
          <p className="mt-3 text-sm text-red-900">
            Is the API running? Try{" "}
            <code className="font-mono">npm run api:dev</code> from the repo
            root, then refresh.
          </p>
        </section>
      )}

      {page && (
        <section>
          <h2 className="text-lg font-semibold mb-3">
            /products — {page.items.length} items
          </h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {page.items.map((p) => (
              <li
                key={p.id}
                className="rounded-md border border-border p-3 bg-card"
              >
                <div className="aspect-square mb-2 bg-muted rounded overflow-hidden">
                  {p.primaryImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.primaryImage.url}
                      alt={p.primaryImage.alt}
                      className="w-full h-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.code}</div>
                <div className="mt-1 text-sm">
                  {formatEur.format(p.priceCents / 100)}
                </div>
                <div className="mt-1 text-xs">
                  {p.stockStatus === "in_stock" ? "В наличност" : "Изчерпан"}
                  {p.isNew ? " · NEW" : ""}
                </div>
                <Link
                  href={`/api-demo?slug=${p.slug}`}
                  className="text-xs text-primary underline mt-2 inline-block"
                >
                  view detail (re-renders below)
                </Link>
              </li>
            ))}
          </ul>
          {page.nextCursor && (
            <p className="mt-3 text-xs text-muted-foreground">
              Next cursor: <code className="font-mono">{page.nextCursor}</code>
            </p>
          )}
        </section>
      )}

      {demoSingle && (
        <section>
          <h2 className="text-lg font-semibold mb-3">
            /products/{demoSingle.slug}
          </h2>
          <pre className="rounded-md bg-muted p-4 text-xs overflow-x-auto">
            {JSON.stringify(demoSingle, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
