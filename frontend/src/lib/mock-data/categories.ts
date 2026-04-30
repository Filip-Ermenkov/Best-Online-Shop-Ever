import { CategoryNode } from "@/lib/types";

// Virtual category for new arrivals — not stored in DB, handled client-side
export const NEW_PRODUCTS_CATEGORY: CategoryNode = {
  id: "cat-new",
  slug: "new-products",
  name: "Нови продукти",
  parentId: null,
  order: 0,
  isArchived: false,
  imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=New+Arrivals",
  children: [],
};

export const categories: CategoryNode[] = [
  {
    id: "cat-1",
    slug: "electronics",
    name: "Електроника",
    parentId: null,
    order: 1,
    isArchived: false,
    imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Electronics",
    children: [
      {
        id: "sub-1-1",
        slug: "phones",
        name: "Телефони",
        parentId: "cat-1",
        order: 1,
        isArchived: false,
        imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Phones",
        children: [
          {
            id: "sub-1-1-1",
            slug: "smartphones",
            name: "Смартфони",
            parentId: "sub-1-1",
            order: 1,
            isArchived: false,
            imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Smartphones",
            children: [],
          },
          {
            id: "sub-1-1-2",
            slug: "feature-phones",
            name: "Обикновени телефони",
            parentId: "sub-1-1",
            order: 2,
            isArchived: false,
            imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Feature+Phones",
            children: [],
          },
        ],
      },
      {
        id: "sub-1-2",
        slug: "laptops",
        name: "Лаптопи",
        parentId: "cat-1",
        order: 2,
        isArchived: false,
        imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Laptops",
        children: [],
      },
      {
        id: "sub-1-3",
        slug: "tablets",
        name: "Таблети",
        parentId: "cat-1",
        order: 3,
        isArchived: false,
        imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Tablets",
        children: [],
      },
      {
        id: "sub-1-4",
        slug: "accessories",
        name: "Аксесоари",
        parentId: "cat-1",
        order: 4,
        isArchived: false,
        imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Accessories",
        children: [],
      },
    ],
  },
  {
    id: "cat-2",
    slug: "home-appliances",
    name: "Домакински уреди",
    parentId: null,
    order: 2,
    isArchived: false,
    imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Home+Appliances",
    children: [
      { id: "sub-2-1", slug: "kitchen", name: "Кухня", parentId: "cat-2", order: 1, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Kitchen", children: [] },
      { id: "sub-2-2", slug: "cleaning", name: "Почистване", parentId: "cat-2", order: 2, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Cleaning", children: [] },
      { id: "sub-2-3", slug: "climate", name: "Климатизация", parentId: "cat-2", order: 3, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Climate", children: [] },
    ],
  },
  {
    id: "cat-3",
    slug: "tools",
    name: "Инструменти",
    parentId: null,
    order: 3,
    isArchived: false,
    imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Tools",
    children: [
      { id: "sub-3-1", slug: "power-tools", name: "Електроинструменти", parentId: "cat-3", order: 1, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Power+Tools", children: [] },
      { id: "sub-3-2", slug: "hand-tools", name: "Ръчни инструменти", parentId: "cat-3", order: 2, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Hand+Tools", children: [] },
      { id: "sub-3-3", slug: "measuring", name: "Измервателни", parentId: "cat-3", order: 3, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Measuring", children: [] },
    ],
  },
  {
    id: "cat-4",
    slug: "garden",
    name: "Градина",
    parentId: null,
    order: 4,
    isArchived: false,
    imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Garden",
    children: [
      { id: "sub-4-1", slug: "gardening-tools", name: "Градински инструменти", parentId: "cat-4", order: 1, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Garden+Tools", children: [] },
      { id: "sub-4-2", slug: "outdoor-furniture", name: "Градинска мебел", parentId: "cat-4", order: 2, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Outdoor+Furniture", children: [] },
    ],
  },
  {
    id: "cat-5",
    slug: "sports",
    name: "Спорт и свободно време",
    parentId: null,
    order: 5,
    isArchived: false,
    imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Sports",
    children: [
      { id: "sub-5-1", slug: "fitness", name: "Фитнес", parentId: "cat-5", order: 1, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Fitness", children: [] },
      { id: "sub-5-2", slug: "outdoor-sports", name: "Outdoor спорт", parentId: "cat-5", order: 2, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Outdoor", children: [] },
      { id: "sub-5-3", slug: "cycling", name: "Велосипеди", parentId: "cat-5", order: 3, isArchived: false, imageUrl: "https://placehold.co/600x400/1C1C2E/C9A96E?text=Cycling", children: [] },
    ],
  },
];

// ─── Recursive helpers ──────────────────────────────────────────────────────

/** Flatten the entire tree into a list */
export function flattenCategories(nodes: CategoryNode[] = categories): CategoryNode[] {
  const result: CategoryNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children.length > 0) result.push(...flattenCategories(node.children));
  }
  return result;
}

/** Find a category by ID anywhere in the tree */
export function getCategoryById(id: string): CategoryNode | undefined {
  return flattenCategories().find((c) => c.id === id);
}

/** Find a category by slug anywhere in the tree */
export function getCategoryBySlug(slug: string): CategoryNode | undefined {
  if (slug === "new-products") return NEW_PRODUCTS_CATEGORY;
  return flattenCategories().find((c) => c.slug === slug);
}

/**
 * Resolve a URL path array like ["electronics", "phones", "smartphones"]
 * into the chain of CategoryNodes. Returns null if any segment doesn't match.
 */
export function resolveCategoryPath(slugs: string[]): CategoryNode[] | null {
  const chain: CategoryNode[] = [];
  let current: CategoryNode[] = categories;

  for (const slug of slugs) {
    const found = current.find((c) => c.slug === slug && !c.isArchived);
    if (!found) return null;
    chain.push(found);
    current = found.children;
  }

  return chain;
}

/**
 * Get the full ancestor chain from root to a given category (by id).
 * Useful for breadcrumbs.
 */
export function getCategoryAncestors(categoryId: string): CategoryNode[] {
  const path: CategoryNode[] = [];
  let current = getCategoryById(categoryId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? getCategoryById(current.parentId) : undefined;
  }
  return path;
}

/** Get root-level categories (for nav/homepage) */
export function getRootCategories(): CategoryNode[] {
  return categories.filter((c) => !c.isArchived);
}
