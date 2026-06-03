"use client";

import AdminSidebar from "@/components/admin/AdminSidebar";
import { AdminSidebarProvider, useAdminSidebar } from "@/contexts/AdminSidebarContext";
import { Menu } from "lucide-react";

/**
 * Client-only UI shell for the admin section. Split from layout.tsx so the
 * outer layout can be a server component (and call getServerUser). All the
 * sidebar/mobile-header state lives here behind "use client".
 */

function AdminMobileHeader() {
  const { setOpen } = useAdminSidebar();
  return (
    <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-sidebar border-b border-sidebar-border sticky top-0 z-30">
      <button
        onClick={() => setOpen(true)}
        className="p-1.5 rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        aria-label="Отвори меню"
      >
        <Menu className="w-5 h-5" />
      </button>
      <span className="font-bold text-sm text-sidebar-foreground">Администрация</span>
    </header>
  );
}

export default function AdminLayoutShell({ children }: { children: React.ReactNode }) {
  return (
    <AdminSidebarProvider>
      <div className="min-h-screen flex bg-muted/30">
        <AdminSidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <AdminMobileHeader />
          {/* Skip-link target (mirrors the storefront <main>) so the global
              "skip to content" link works in the admin section too. */}
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 p-4 lg:p-6 overflow-y-auto focus:outline-none"
          >
            {children}
          </main>
        </div>
      </div>
    </AdminSidebarProvider>
  );
}
