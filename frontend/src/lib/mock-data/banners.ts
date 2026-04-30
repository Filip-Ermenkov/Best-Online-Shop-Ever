import { Banner } from "@/lib/types";

export const banners: Banner[] = [
  {
    id: "banner-1",
    title: "Пролетни намаления",
    subtitle: "До -30% на избрани продукти",
    imageUrl: "https://placehold.co/1400x500/1e3a5f/ffffff?text=Spring+Sale",
    linkUrl: "/products",
    linkLabel: "Разгледай",
    isActive: true,
    order: 1,
  },
  {
    id: "banner-2",
    title: "Нови електроинструменти",
    subtitle: "Bosch, Makita и още – вече налични",
    imageUrl: "https://placehold.co/1400x500/1a3c2e/ffffff?text=New+Tools",
    linkUrl: "/products/tools",
    linkLabel: "Виж продуктите",
    isActive: true,
    order: 2,
  },
  {
    id: "banner-3",
    title: "Безплатна доставка",
    subtitle: "При поръчка над 100 EUR",
    imageUrl: "https://placehold.co/1400x500/3b1f5e/ffffff?text=Free+Delivery",
    linkUrl: "/products",
    linkLabel: "Пазарувай сега",
    isActive: true,
    order: 3,
  },
];
