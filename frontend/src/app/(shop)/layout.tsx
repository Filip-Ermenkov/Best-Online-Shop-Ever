import Header from "@/components/layout/Header";
import NavBar from "@/components/layout/NavBar";
import Footer from "@/components/layout/Footer";
import CookieBanner from "@/components/layout/CookieBanner";
import EmailVerificationBanner from "@/components/layout/EmailVerificationBanner";
import { fetchCategoryTree } from "@/lib/api";
import type { CategoryTreeNode } from "@/lib/catalog";

/**
 * Async Server Component layout. Fetches the live category tree ONCE per
 * request — Next.js dedupes the fetch via the `tags: ["categories"]` hint in
 * `fetchCategoryTree`, so other Server Components in the same render that
 * call `fetchCategoryTree()` independently share the result. The 5-minute
 * `revalidate` window matches the API's `Cache-Control: s-maxage=300`, so
 * the in-memory hit covers most repeat navigations.
 *
 * Failure mode: if the API is unreachable, `fetchCategoryTree` throws
 * `ApiClientError`. We catch it here and render with an empty tree rather
 * than failing the whole shop — the storefront still works, the mega-menu
 * just shows no categories. Pages that depend on the tree for their own
 * resolution (catch-all products page) will surface their own error UI.
 */
export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let categoryTree: CategoryTreeNode[] = [];
  try {
    const result = await fetchCategoryTree();
    categoryTree = result.items;
  } catch {
    // Layout must keep rendering — header/footer/email-banner are useful
    // even if the catalog is temporarily unreachable. NavBar will render
    // with an empty tree (no categories shown) and the page-level UI
    // surfaces the real error via Next.js's nearest error.tsx.
  }

  return (
    <>
      <Header />
      <NavBar tree={categoryTree} />
      <EmailVerificationBanner />
      <main className="flex-1">{children}</main>
      <Footer />
      <CookieBanner />
    </>
  );
}
