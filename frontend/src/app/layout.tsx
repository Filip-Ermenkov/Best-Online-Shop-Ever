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

export const metadata: Metadata = {
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
        <AuthProvider initialUser={initialUser}>
          <CartProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
