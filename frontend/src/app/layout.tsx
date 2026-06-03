import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { CartProvider } from "@/contexts/CartContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getServerUser } from "@/lib/auth/server";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

/**
 * `metadataBase` is the absolute URL Next.js uses to resolve any relative
 * canonical / OG-image / Twitter-image URLs declared further down the tree
 * (notably the storefront product pages, which use
 * `alternates.canonical: "/products/..."`). Without it Next.js emits a
 * build-time warning and OG images that ship to social-preview scrapers
 * resolve against `http://localhost:3000` — fine in dev, broken in prod.
 *
 * Pulled from a public env var so the same build can target any host. The
 * fallback only fires during pure local dev.
 */
const siteBaseUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ??
  "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteBaseUrl),
  title: "Duda 1",
  description: "Онлайн магазин с широка гама от продукти",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // SSR identity bootstrap. Pass the server-resolved user into the client
  // AuthProvider so the very first paint already knows whether the visitor
  // is logged in. Without this, the header briefly shows "Sign in" then
  // flips to "Hi, Иван" once the client-side /auth/me resolves — a
  // classic auth-flicker that's especially jarring on slow connections.
  const initialUser = await getServerUser();

  return (
    <html lang="bg" data-scroll-behavior="smooth" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {/* WCAG 2.4.1 Bypass Blocks: keyboard users land here first and can
            jump past the header/nav straight to the page content. Styled by
            `.skip-link` in globals.css — hidden until focused. */}
        <a href="#main-content" className="skip-link">
          Прескочи към съдържанието
        </a>
        <AuthProvider initialUser={initialUser}>
          <CartProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
