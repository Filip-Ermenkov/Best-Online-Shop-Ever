import { CheckCircle, Package } from "lucide-react";
import { ButtonLink } from "@/components/ui/button-link";

interface Props {
  searchParams: Promise<{ orderId?: string }>;
}

export default async function OrderConfirmationPage({ searchParams }: Props) {
  const { orderId } = await searchParams;

  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
        <CheckCircle className="w-9 h-9 text-green-600" />
      </div>

      <h1 className="text-2xl font-bold mb-2">Поръчката е приета!</h1>
      {orderId && (
        <p className="text-muted-foreground mb-1">
          Номер на поръчка: <span className="font-semibold text-foreground">{orderId}</span>
        </p>
      )}
      <p className="text-muted-foreground mt-2 mb-8">
        Изпратихме потвърждение на вашия имейл адрес. Ще бъдете уведомени при промяна на статуса на поръчката.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <ButtonLink variant="outline" className="gap-2" href="/account/orders">
          <Package className="w-4 h-4" /> Моите поръчки
        </ButtonLink>
        <ButtonLink href="/products">Продължи пазаруването</ButtonLink>
      </div>
    </div>
  );
}
