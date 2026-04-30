// ─── Product ────────────────────────────────────────────────────────────────

export type StockStatus = "in_stock" | "out_of_stock";

export interface ProductImage {
  id: string;
  url: string;
  alt: string;
}

export interface ProductVariantOption {
  id: string;
  label: string;
  imageUrl?: string; // optional image per variant option
  available: boolean;
}

export interface ProductVariant {
  id: string;
  name: string; // e.g. "Цвят", "Размер"
  options: ProductVariantOption[];
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  code: string;
  description: string;
  price: number;
  originalPrice?: number;
  currency: "EUR";
  images: ProductImage[];
  categoryId: string; // direct parent category id (at any depth)
  stockStatus: StockStatus;
  stockQuantity: number;
  isNew: boolean;
  variants?: ProductVariant[];
  displayOrder: number; // for drag-and-drop ordering within a category
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
}

// ─── Category (recursive, infinite depth) ───────────────────────────────────

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  parentId: string | null; // null = root category
  children: CategoryNode[];
  order: number;
  isArchived: boolean;
  imageUrl?: string;
}

// ─── Cart ────────────────────────────────────────────────────────────────────

export interface CartItem {
  productId: string;
  name: string;
  code: string;
  price: number;
  imageUrl: string;
  quantity: number;
  stockStatus: StockStatus;
  selectedVariants?: Record<string, string>; // variantId → optionId
}

// ─── Order ───────────────────────────────────────────────────────────────────

export type OrderStatus =
  | "processing"
  | "shipped"
  | "ready_for_pickup"
  | "delivered"
  | "accepted"
  | "returned"
  | "cancelled";

export type DeliveryMethod = "courier" | "pickup";
export type PaymentMethod = "cash_on_delivery" | "pay_at_store";

export interface OrderItem {
  productId: string;
  name: string;
  code: string;
  price: number;
  quantity: number;
  imageUrl: string;
}

export interface DeliveryAddress {
  name: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CourierInfo {
  company: string;
  trackingNumber: string;
  trackingUrl?: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId?: string; // undefined for guest orders
  customerEmail: string;
  items: OrderItem[];
  status: OrderStatus;
  deliveryMethod: DeliveryMethod;
  deliveryAddress?: DeliveryAddress;
  paymentMethod: PaymentMethod;
  subtotal: number;
  discountAmount: number;
  total: number;
  courierInfo?: CourierInfo;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Customer ────────────────────────────────────────────────────────────────

export type AccountType = "personal" | "corporate";

export interface Customer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  accountType: AccountType;
  companyName?: string;
  vatNumber?: string;
  discountPercent: number; // 0–100, set by admin
  createdAt: string;
  isActive: boolean;
}

// ─── Banner ──────────────────────────────────────────────────────────────────

export interface Banner {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
  linkUrl?: string;
  linkLabel?: string;
  isActive: boolean;
  order: number;
}

// ─── Checkout ────────────────────────────────────────────────────────────────

export interface CheckoutFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  address?: {
    street: string;
    city: string;
    postalCode: string;
    country: string;
  };
  courierCompany?: "econt" | "speedy";
  deliveryType?: "to_address" | "to_office";
  officeId?: string;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export type UserRole = "guest" | "customer" | "admin";

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  accountType?: AccountType;
  discountPercent: number;
}
