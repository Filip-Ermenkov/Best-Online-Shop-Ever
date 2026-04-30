import { Product } from "@/lib/types";

export const products: Product[] = [
  // Electronics – Phones – Smartphones
  {
    id: "prod-1",
    slug: "samsung-galaxy-a55",
    name: "Samsung Galaxy A55 5G",
    code: "EL-PH-001",
    description:
      "Смартфон с 6.6-инчов Super AMOLED дисплей, 50MP тройна камера, 5000mAh батерия и 5G свързаност. Перфектен за ежедневна употреба.",
    price: 549.99,
    currency: "EUR",
    images: [
      { id: "img-1-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Samsung+A55", alt: "Samsung Galaxy A55 5G" },
      { id: "img-1-2", url: "https://placehold.co/600x600/e2e8f0/475569?text=A55+Back", alt: "Samsung Galaxy A55 – гръб" },
      { id: "img-1-3", url: "https://placehold.co/600x600/e2e8f0/475569?text=A55+Side", alt: "Samsung Galaxy A55 – страна" },
    ],
    categoryId: "sub-1-1-1", // smartphones
    stockStatus: "in_stock",
    stockQuantity: 24,
    isNew: true,
    displayOrder: 1,
    variants: [
      {
        id: "var-1-color",
        name: "Цвят",
        options: [
          { id: "opt-black", label: "Черен", available: true, imageUrl: "https://placehold.co/600x600/1a1a2e/c9a96e?text=A55+Black" },
          { id: "opt-white", label: "Бял", available: true, imageUrl: "https://placehold.co/600x600/f5f5f5/475569?text=A55+White" },
          { id: "opt-blue", label: "Син", available: false, imageUrl: "https://placehold.co/600x600/3b82f6/ffffff?text=A55+Blue" },
        ],
      },
    ],
    createdAt: "2026-03-15T10:00:00Z",
    updatedAt: "2026-04-01T08:00:00Z",
    isArchived: false,
  },
  {
    id: "prod-2",
    slug: "iphone-15",
    name: "Apple iPhone 15 128GB",
    code: "EL-PH-002",
    description:
      "iPhone 15 с чип A16 Bionic, 48MP главна камера, Dynamic Island и USB-C зареждане. Произведен от рециклируем алуминий.",
    price: 899.99,
    originalPrice: 999.99,
    currency: "EUR",
    images: [
      { id: "img-2-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=iPhone+15", alt: "Apple iPhone 15" },
      { id: "img-2-2", url: "https://placehold.co/600x600/e2e8f0/475569?text=iPhone+15+Side", alt: "Apple iPhone 15 – страна" },
    ],
    categoryId: "sub-1-1-1", // smartphones
    stockStatus: "in_stock",
    stockQuantity: 3,
    isNew: false,
    displayOrder: 2,
    createdAt: "2026-01-10T10:00:00Z",
    updatedAt: "2026-04-05T12:00:00Z",
    isArchived: false,
  },
  // Electronics – Laptops
  {
    id: "prod-3",
    slug: "lenovo-ideapad-5",
    name: "Lenovo IdeaPad 5 15 Intel",
    code: "EL-LP-001",
    description:
      "Лаптоп с 15.6-инчов FHD IPS дисплей, Intel Core i5-1335U, 16GB RAM, 512GB SSD. Тънък, лек и подходящ за работа и учение.",
    price: 779.99,
    currency: "EUR",
    images: [
      { id: "img-3-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Lenovo+IdeaPad+5", alt: "Lenovo IdeaPad 5" },
      { id: "img-3-2", url: "https://placehold.co/600x600/e2e8f0/475569?text=IdeaPad+Open", alt: "Lenovo IdeaPad 5 – отворен" },
    ],
    categoryId: "sub-1-2", // laptops
    stockStatus: "in_stock",
    stockQuantity: 12,
    isNew: true,
    displayOrder: 1,
    createdAt: "2026-03-20T10:00:00Z",
    updatedAt: "2026-03-20T10:00:00Z",
    isArchived: false,
  },
  {
    id: "prod-4",
    slug: "macbook-air-m2",
    name: "Apple MacBook Air 13\" M2",
    code: "EL-LP-002",
    description:
      "MacBook Air с чип Apple M2, 13.6-инчов Liquid Retina дисплей, 8GB унифицирана памет, 256GB SSD. До 18 часа батерия.",
    price: 1299.99,
    originalPrice: 1399.99,
    currency: "EUR",
    images: [
      { id: "img-4-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=MacBook+Air+M2", alt: "Apple MacBook Air M2" },
      { id: "img-4-2", url: "https://placehold.co/600x600/e2e8f0/475569?text=MacBook+Side", alt: "Apple MacBook Air M2 – страна" },
    ],
    categoryId: "sub-1-2", // laptops
    stockStatus: "in_stock",
    stockQuantity: 8,
    isNew: false,
    displayOrder: 2,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-04-02T10:00:00Z",
    isArchived: false,
  },
  // Home Appliances – Kitchen
  {
    id: "prod-5",
    slug: "bosch-coffee-maker",
    name: "Bosch TKA6A044 Кафемашина",
    code: "HA-KT-001",
    description:
      "Автоматична кафемашина с филтър, 1200W, 1.25L резервоар, Anti-drip система и стъклена кана. Перфектна за офис и дом.",
    price: 59.99,
    currency: "EUR",
    images: [
      { id: "img-5-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Bosch+Coffee+Maker", alt: "Bosch кафемашина" },
    ],
    categoryId: "sub-2-1", // kitchen
    stockStatus: "in_stock",
    stockQuantity: 30,
    isNew: false,
    displayOrder: 1,
    createdAt: "2025-11-01T10:00:00Z",
    updatedAt: "2026-01-15T10:00:00Z",
    isArchived: false,
  },
  {
    id: "prod-6",
    slug: "philips-airfryer",
    name: "Philips Air Fryer HD9252/90",
    code: "HA-KT-002",
    description:
      "Уред за готвене с горещ въздух, 4.1L, 1400W. Готви с до 90% по-малко мазнина. Включва готварска книга с 200 рецепти.",
    price: 129.99,
    originalPrice: 159.99,
    currency: "EUR",
    images: [
      { id: "img-6-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Philips+AirFryer", alt: "Philips Air Fryer" },
    ],
    categoryId: "sub-2-1", // kitchen
    stockStatus: "in_stock",
    stockQuantity: 2,
    isNew: false,
    displayOrder: 2,
    createdAt: "2025-12-01T10:00:00Z",
    updatedAt: "2026-03-28T10:00:00Z",
    isArchived: false,
  },
  // Tools – Power Tools
  {
    id: "prod-7",
    slug: "bosch-drill-gsb-18v",
    name: "Bosch GSB 18V-55 Ударна бормашина",
    code: "TL-PT-001",
    description:
      "Безжична ударна бормашина 18V с 2×2Ah батерии, зарядно устройство и L-BOXX куфар. 55Nm въртящ момент, 2-скоростна предавателна кутия.",
    price: 219.99,
    currency: "EUR",
    images: [
      { id: "img-7-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Bosch+GSB+18V", alt: "Bosch ударна бормашина" },
    ],
    categoryId: "sub-3-1", // power tools
    stockStatus: "in_stock",
    stockQuantity: 15,
    isNew: true,
    displayOrder: 1,
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    isArchived: false,
  },
  {
    id: "prod-8",
    slug: "makita-circular-saw",
    name: "Makita DSS611Z Циркуляр 18V",
    code: "TL-PT-002",
    description:
      "Безжичен циркуляр 18V, диск 165mm, дълбочина на рязане 57mm. Без батерия – съвместим с всички Makita 18V батерии.",
    price: 149.99,
    currency: "EUR",
    images: [
      { id: "img-8-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Makita+DSS611Z", alt: "Makita циркуляр" },
    ],
    categoryId: "sub-3-1", // power tools
    stockStatus: "out_of_stock",
    stockQuantity: 0,
    isNew: false,
    displayOrder: 2,
    createdAt: "2025-10-15T10:00:00Z",
    updatedAt: "2026-02-20T10:00:00Z",
    isArchived: false,
  },
  // Sports – Fitness
  {
    id: "prod-9",
    slug: "garmin-forerunner-55",
    name: "Garmin Forerunner 55 GPS часовник",
    code: "SP-FT-001",
    description:
      "GPS смарт часовник за бягане с измерване на сърдечен ритъм, до 20 дни батерия, проследяване на сън и стрес. Водоустойчив 5ATM.",
    price: 189.99,
    originalPrice: 229.99,
    currency: "EUR",
    images: [
      { id: "img-9-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Garmin+Forerunner+55", alt: "Garmin Forerunner 55" },
    ],
    categoryId: "sub-5-1", // fitness
    stockStatus: "in_stock",
    stockQuantity: 18,
    isNew: false,
    displayOrder: 1,
    createdAt: "2025-09-01T10:00:00Z",
    updatedAt: "2026-03-10T10:00:00Z",
    isArchived: false,
  },
  // Garden – Gardening Tools
  {
    id: "prod-10",
    slug: "husqvarna-lawnmower",
    name: "Husqvarna LC141Li Косачка",
    code: "GD-GT-001",
    description:
      "Акумулаторна косачка 40V, ширина на косене 41cm, без кабел и газ. Включва 1×4Ah батерия и зарядно. Тиха и ефективна.",
    price: 449.99,
    currency: "EUR",
    images: [
      { id: "img-10-1", url: "https://placehold.co/600x600/e2e8f0/475569?text=Husqvarna+LC141Li", alt: "Husqvarna косачка" },
    ],
    categoryId: "sub-4-1", // gardening tools
    stockStatus: "in_stock",
    stockQuantity: 6,
    isNew: true,
    displayOrder: 1,
    createdAt: "2026-04-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
    isArchived: false,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug && !p.isArchived);
}

/** Get products directly in a category (by category ID) */
export function getProductsByCategoryId(categoryId: string): Product[] {
  return products
    .filter((p) => p.categoryId === categoryId && !p.isArchived)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

export function getNewProducts(): Product[] {
  return products.filter((p) => p.isNew && !p.isArchived);
}

export function getFeaturedProducts(limit = 4): Product[] {
  return products.filter((p) => !p.isArchived).slice(0, limit);
}

export function searchProducts(query: string): Product[] {
  const q = query.toLowerCase();
  return products.filter(
    (p) =>
      !p.isArchived &&
      (p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q))
  );
}
