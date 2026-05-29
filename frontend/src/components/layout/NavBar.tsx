"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Menu, X, LayoutGrid } from "lucide-react";
import type { CategoryTreeNode } from "@/lib/catalog";
import { cn } from "@/lib/utils";

/**
 * NavBar is a Client Component (the mega-menu open/close + mobile drawer all
 * need React state), but receives the category tree as a prop from the
 * server-rendered `(shop)/layout.tsx`. That keeps the tree fetch off the
 * client bundle entirely.
 *
 * The tree comes from `@shop/api`'s `GET /categories`. The "Нови продукти"
 * virtual entry isn't a real category in the DB — it lives client-side only
 * and routes to `/products/new-products`, where the catch-all page knows to
 * render the "newest products" view.
 */

const VISIBLE_ROOT_COUNT = 6;

/**
 * Virtual "new products" nav entry. Not a row in the categories table; the
 * catch-all `/products/[...path]` route handles `["new-products"]` as a
 * special case and renders the newest-first product list.
 */
const NEW_PRODUCTS_ENTRY: CategoryTreeNode = {
  id: "__virtual_new_products__",
  slug: "new-products",
  name: "Нови продукти",
  imageUrl: null,
  displayOrder: -1,
  children: [],
};

function buildCategoryPath(
  cat: CategoryTreeNode,
  ancestors: CategoryTreeNode[] = [],
): string {
  return "/products/" + [...ancestors, cat].map((c) => c.slug).join("/");
}

interface NavBarProps {
  /** Live category tree from `GET /categories`. May be empty on API error. */
  tree: CategoryTreeNode[];
}

export default function NavBar({ tree }: NavBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="bg-[oklch(0.18_0.02_270)] text-[oklch(0.96_0.005_270)] relative">
      <DesktopNav tree={tree} />

      <div className="md:hidden flex items-center justify-between px-4 py-2">
        <span className="text-sm font-medium">Категории</span>
        <button
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Затвори меню" : "Отвори меню"}
          className="p-1"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <MobileNav tree={tree} onClose={() => setMobileOpen(false)} />
      )}
    </nav>
  );
}

// ─── Desktop: Mega menu with click-to-open "Всички категории" ───────────────

function DesktopNav({ tree }: { tree: CategoryTreeNode[] }) {
  const rootCategories = tree;
  const visibleRoots = rootCategories.slice(0, VISIBLE_ROOT_COUNT);

  const [allOpen, setAllOpen] = useState(false);
  const [hoveredRootId, setHoveredRootId] = useState<string | null>(null);
  const allMenuRef = useRef<HTMLDivElement>(null);
  const allButtonRef = useRef<HTMLButtonElement>(null);

  const [hoveredVisibleId, setHoveredVisibleId] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);

  function openAll() {
    setAllOpen(true);
    if (!hoveredRootId && rootCategories[0]) setHoveredRootId(rootCategories[0].id);
  }

  function closeAll() {
    setAllOpen(false);
    setHoveredRootId(null);
  }

  useEffect(() => {
    if (!allOpen) return;
    function onClick(e: MouseEvent) {
      if (
        allMenuRef.current?.contains(e.target as Node) ||
        allButtonRef.current?.contains(e.target as Node)
      )
        return;
      closeAll();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [allOpen]);

  useEffect(() => {
    if (!allOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeAll();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [allOpen]);

  const hoveredRoot = hoveredRootId
    ? rootCategories.find((r) => r.id === hoveredRootId)
    : null;

  function setVisibleHoverDebounced(id: string | null) {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (id === null) {
      hoverTimer.current = window.setTimeout(() => setHoveredVisibleId(null), 120);
    } else {
      setHoveredVisibleId(id);
    }
  }

  return (
    <div className="relative hidden md:block">
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-center gap-0">
        <button
          ref={allButtonRef}
          onClick={() => (allOpen ? closeAll() : openAll())}
          className={cn(
            "flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-colors whitespace-nowrap border-b-2 flex-shrink-0",
            allOpen
              ? "bg-[oklch(0.22_0.02_270)] text-[oklch(0.73_0.10_75)] border-[oklch(0.73_0.10_75)]"
              : "hover:bg-[oklch(0.22_0.02_270)] hover:text-[oklch(0.73_0.10_75)] border-transparent"
          )}
          aria-expanded={allOpen}
          aria-haspopup="menu"
        >
          <LayoutGrid className="w-4 h-4" />
          Всички категории
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 transition-transform",
              allOpen && "rotate-180"
            )}
          />
        </button>

        <VisibleRootItem
          cat={NEW_PRODUCTS_ENTRY}
          hoveredVisibleId={hoveredVisibleId}
          setHover={setVisibleHoverDebounced}
        />

        {visibleRoots.map((cat) => (
          <VisibleRootItem
            key={cat.id}
            cat={cat}
            hoveredVisibleId={hoveredVisibleId}
            setHover={setVisibleHoverDebounced}
          />
        ))}
      </div>

      {allOpen && (
        <div
          ref={allMenuRef}
          className="absolute left-0 right-0 top-full z-50 bg-white text-foreground shadow-2xl border-t border-border animate-mega-slide"
        >
          <div className="max-w-7xl mx-auto grid grid-cols-12 min-h-[420px] max-h-[70vh]">
            <div className="col-span-4 lg:col-span-3 border-r border-border bg-muted/30 overflow-y-auto py-2">
              {rootCategories.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">
                  Няма налични категории.
                </p>
              ) : (
                rootCategories.map((cat) => (
                  <Link
                    key={cat.id}
                    href={buildCategoryPath(cat)}
                    onMouseEnter={() => setHoveredRootId(cat.id)}
                    onClick={closeAll}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors",
                      hoveredRootId === cat.id
                        ? "bg-white text-[oklch(0.73_0.10_75)] font-semibold"
                        : "hover:bg-white/60 text-foreground"
                    )}
                  >
                    <span className="truncate">{cat.name}</span>
                    <ChevronRight className="w-4 h-4 flex-shrink-0 opacity-50" />
                  </Link>
                ))
              )}
            </div>

            <div className="col-span-8 lg:col-span-9 p-6 overflow-y-auto">
              {hoveredRoot && <MegaSubPanel root={hoveredRoot} onClose={closeAll} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VisibleRootItem({
  cat,
  hoveredVisibleId,
  setHover,
}: {
  cat: CategoryTreeNode;
  hoveredVisibleId: string | null;
  setHover: (id: string | null) => void;
}) {
  const activeChildren = cat.children;
  const isOpen = hoveredVisibleId === cat.id;
  const href = buildCategoryPath(cat);

  return (
    <div
      className="relative flex-shrink-0"
      onMouseEnter={() => setHover(cat.id)}
      onMouseLeave={() => setHover(null)}
    >
      <Link
        href={href}
        className={cn(
          "flex items-center gap-1 px-3 py-3 text-sm font-medium transition-colors whitespace-nowrap border-b-2",
          isOpen
            ? "text-[oklch(0.73_0.10_75)] border-[oklch(0.73_0.10_75)]"
            : "hover:text-[oklch(0.73_0.10_75)] border-transparent hover:border-[oklch(0.73_0.10_75)]/50"
        )}
      >
        {cat.name}
        {activeChildren.length > 0 && (
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 opacity-70 transition-transform",
              isOpen && "rotate-180"
            )}
          />
        )}
      </Link>
      {activeChildren.length > 0 && isOpen && (
        <div className="absolute left-0 top-full z-50 min-w-[220px] bg-white text-foreground shadow-lg rounded-b-md border border-t-0 border-border py-1 animate-scale-in">
          {[...activeChildren]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((child) => (
              <DesktopDropdownItem key={child.id} cat={child} ancestors={[cat]} />
            ))}
        </div>
      )}
    </div>
  );
}

function DesktopDropdownItem({
  cat,
  ancestors,
}: {
  cat: CategoryTreeNode;
  ancestors: CategoryTreeNode[];
}) {
  const activeChildren = cat.children;
  const href = buildCategoryPath(cat, ancestors);

  return (
    <div className="relative group/sub">
      <Link
        href={href}
        className="flex items-center justify-between px-4 py-2 text-sm hover:bg-muted hover:text-[oklch(0.73_0.10_75)] transition-colors"
      >
        {cat.name}
        {activeChildren.length > 0 && <ChevronRight className="w-3.5 h-3.5 opacity-50" />}
      </Link>
      {activeChildren.length > 0 && (
        <div className="absolute left-full top-0 z-50 hidden group-hover/sub:block min-w-[220px] bg-white text-foreground shadow-lg rounded-md border border-border py-1">
          {[...activeChildren]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((child) => (
              <DesktopDropdownItem
                key={child.id}
                cat={child}
                ancestors={[...ancestors, cat]}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function MegaSubPanel({
  root,
  onClose,
}: {
  root: CategoryTreeNode;
  onClose: () => void;
}) {
  const activeChildren = root.children;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 pb-3 border-b border-border">
        <Link
          href={buildCategoryPath(root)}
          onClick={onClose}
          className="text-base font-bold text-foreground hover:text-[oklch(0.73_0.10_75)] transition-colors inline-flex items-center gap-1"
        >
          {root.name}
          <ChevronRight className="w-4 h-4" />
        </Link>
        <Link
          href={buildCategoryPath(root)}
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-[oklch(0.73_0.10_75)] transition-colors"
        >
          Виж всички →
        </Link>
      </div>

      {activeChildren.length > 0 ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
          {[...activeChildren]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((sub) => {
              const subChildren = sub.children;
              return (
                <div key={sub.id}>
                  <Link
                    href={buildCategoryPath(sub, [root])}
                    onClick={onClose}
                    className="text-sm font-semibold text-foreground hover:text-[oklch(0.73_0.10_75)] transition-colors mb-2 block"
                  >
                    {sub.name}
                  </Link>
                  {subChildren.length > 0 && (
                    <ul className="space-y-1">
                      {[...subChildren]
                        .sort((a, b) => a.displayOrder - b.displayOrder)
                        .map((leaf) => (
                          <li key={leaf.id}>
                            <Link
                              href={buildCategoryPath(leaf, [root, sub])}
                              onClick={onClose}
                              className="text-xs text-muted-foreground hover:text-[oklch(0.73_0.10_75)] transition-colors"
                            >
                              {leaf.name}
                            </Link>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              );
            })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Няма подкатегории.</p>
      )}
    </div>
  );
}

// ─── Mobile: recursive accordion ────────────────────────────────────────────

function MobileNav({
  tree,
  onClose,
}: {
  tree: CategoryTreeNode[];
  onClose: () => void;
}) {
  const rootNavCategories = [NEW_PRODUCTS_ENTRY, ...tree];
  return (
    <div className="md:hidden border-t border-white/10 bg-[oklch(0.18_0.02_270)] max-h-[70vh] overflow-y-auto">
      {rootNavCategories.length === 1 ? (
        <p className="px-4 py-4 text-sm text-white/70">
          Няма налични категории.
        </p>
      ) : (
        rootNavCategories.map((cat) => (
          <MobileCategoryItem
            key={cat.id}
            cat={cat}
            ancestors={[]}
            depth={0}
            onClose={onClose}
          />
        ))
      )}
    </div>
  );
}

function MobileCategoryItem({
  cat,
  ancestors,
  depth,
  onClose,
}: {
  cat: CategoryTreeNode;
  ancestors: CategoryTreeNode[];
  depth: number;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activeChildren = cat.children;
  const href = buildCategoryPath(cat, ancestors);
  const indent = 16 + depth * 16;

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: indent }}>
        <Link
          href={href}
          onClick={onClose}
          className="flex-1 py-3 pr-2 text-sm font-medium hover:text-[oklch(0.73_0.10_75)] transition-colors"
        >
          {cat.name}
        </Link>
        {activeChildren.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-3 hover:text-[oklch(0.73_0.10_75)] transition-colors"
            aria-label={expanded ? "Свий" : "Разгъни"}
          >
            <ChevronDown
              className={cn("w-4 h-4 transition-transform", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {expanded && activeChildren.length > 0 && (
        <div className="bg-white/5">
          {[...activeChildren]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((child) => (
              <MobileCategoryItem
                key={child.id}
                cat={child}
                ancestors={[...ancestors, cat]}
                depth={depth + 1}
                onClose={onClose}
              />
            ))}
        </div>
      )}
    </div>
  );
}
