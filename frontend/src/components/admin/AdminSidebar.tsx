"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Package, ShoppingBag, Users,
  Tag, Image, Settings, LogOut, ChevronRight, Archive, X
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminSidebar } from "@/contexts/AdminSidebarContext";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/admin", label: "Табло", icon: LayoutDashboard, exact: true },
  { href: "/admin/products", label: "Продукти", icon: Package },
  { href: "/admin/categories", label: "Категории", icon: Tag },
  { href: "/admin/orders", label: "Поръчки", icon: ShoppingBag },
  { href: "/admin/customers", label: "Клиенти", icon: Users },
  { href: "/admin/banners", label: "Банери", icon: Image },
  { href: "/admin/settings", label: "Настройки", icon: Settings },
  { href: "/admin/archive", label: "Архив", icon: Archive },
];

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { logout } = useAuth();

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-sidebar-border flex items-center justify-between">
        <Link href="/admin" className="flex items-center gap-2" onClick={onClose}>
          <div className="w-7 h-7 rounded bg-sidebar-primary flex items-center justify-center text-sidebar-primary-foreground font-bold text-xs">D</div>
          <span className="font-bold text-sm">Duda 1 · Admin</span>
        </Link>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
              {active && <ChevronRight className="w-3 h-3 ml-auto" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-2 py-3 border-t border-sidebar-border space-y-1">
        <Link
          href="/"
          onClick={onClose}
          className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          <ChevronRight className="w-4 h-4 rotate-180" /> Към магазина
        </Link>
        <button
          onClick={() => { onClose?.(); logout(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-sidebar-foreground/60 hover:bg-destructive/20 hover:text-destructive transition-colors"
        >
          <LogOut className="w-4 h-4" /> Изход
        </button>
      </div>
    </div>
  );
}

export default function AdminSidebar() {
  const { open, setOpen } = useAdminSidebar();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 flex-shrink-0 flex-col min-h-screen">
        <SidebarContent />
      </aside>

      {/* Mobile sheet drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="p-0 w-56 [&>button]:hidden">
          <SidebarContent onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
