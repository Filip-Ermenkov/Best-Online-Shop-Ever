import { Order } from "@/lib/types";

export const orders: Order[] = [
  {
    id: "order-1",
    orderNumber: "ORD-2026-0001",
    customerId: "cust-1",
    customerEmail: "ivan.petrov@example.com",
    items: [
      {
        productId: "prod-1",
        name: "Samsung Galaxy A55 5G",
        code: "EL-PH-001",
        price: 549.99,
        quantity: 1,
        imageUrl: "https://placehold.co/100x100/e2e8f0/475569?text=A55",
      },
      {
        productId: "prod-5",
        name: "Bosch TKA6A044 Кафемашина",
        code: "HA-KT-001",
        price: 59.99,
        quantity: 1,
        imageUrl: "https://placehold.co/100x100/e2e8f0/475569?text=Bosch",
      },
    ],
    status: "shipped",
    deliveryMethod: "courier",
    deliveryAddress: {
      name: "Иван Петров",
      phone: "+359 88 123 4567",
      email: "ivan.petrov@example.com",
      street: "ул. Витоша 15",
      city: "София",
      postalCode: "1000",
      country: "България",
    },
    paymentMethod: "cash_on_delivery",
    subtotal: 609.98,
    discountAmount: 0,
    total: 609.98,
    courierInfo: {
      company: "Speedy",
      trackingNumber: "SPD-882341",
      trackingUrl: "https://www.speedy.bg/tracking",
    },
    createdAt: "2026-04-03T14:22:00Z",
    updatedAt: "2026-04-05T09:10:00Z",
  },
  {
    id: "order-2",
    orderNumber: "ORD-2026-0002",
    customerId: "cust-2",
    customerEmail: "maria.georgieva@example.com",
    items: [
      {
        productId: "prod-4",
        name: "Apple MacBook Air 13\" M2",
        code: "EL-LP-002",
        price: 1299.99,
        quantity: 1,
        imageUrl: "https://placehold.co/100x100/e2e8f0/475569?text=MacBook",
      },
    ],
    status: "processing",
    deliveryMethod: "pickup",
    paymentMethod: "pay_at_store",
    subtotal: 1299.99,
    discountAmount: 129.99,
    total: 1170.0,
    createdAt: "2026-04-07T10:05:00Z",
    updatedAt: "2026-04-07T10:05:00Z",
  },
  {
    id: "order-3",
    orderNumber: "ORD-2026-0003",
    customerEmail: "guest@example.com",
    items: [
      {
        productId: "prod-7",
        name: "Bosch GSB 18V-55 Ударна бормашина",
        code: "TL-PT-001",
        price: 219.99,
        quantity: 2,
        imageUrl: "https://placehold.co/100x100/e2e8f0/475569?text=Bosch+GSB",
      },
    ],
    status: "delivered",
    deliveryMethod: "courier",
    deliveryAddress: {
      name: "Петър Стоянов",
      phone: "+359 89 765 4321",
      email: "guest@example.com",
      street: "бул. Христо Ботев 42",
      city: "Пловдив",
      postalCode: "4000",
      country: "България",
    },
    paymentMethod: "pay_at_store",
    subtotal: 439.98,
    discountAmount: 0,
    total: 439.98,
    courierInfo: {
      company: "Еконт",
      trackingNumber: "ECT-5594821",
    },
    createdAt: "2026-03-28T11:30:00Z",
    updatedAt: "2026-04-01T16:00:00Z",
  },
];

export function getOrdersByCustomer(customerId: string): Order[] {
  return orders.filter((o) => o.customerId === customerId);
}

export function getOrderById(id: string): Order | undefined {
  return orders.find((o) => o.id === id);
}
