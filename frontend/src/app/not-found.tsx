import { ButtonLink } from "@/components/ui/button-link";
import { Home, ArrowLeft, Search } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <p className="text-8xl font-bold text-primary/20 mb-4">404</p>
      <h1 className="text-2xl font-bold mb-2">Страницата не е намерена</h1>
      <p className="text-muted-foreground max-w-sm mb-8">
        Страницата, която търсите, не съществува или е преместена.
      </p>
      <div className="flex flex-wrap gap-3 justify-center">
        <ButtonLink className="gap-2" href="/">
          <Home className="w-4 h-4" /> Начална страница
        </ButtonLink>
        <ButtonLink variant="outline" className="gap-2" href="/products">
          <Search className="w-4 h-4" /> Разгледай продукти
        </ButtonLink>
        <ButtonLink variant="ghost" className="gap-2" href="javascript:history.back()">
          <ArrowLeft className="w-4 h-4" /> Назад
        </ButtonLink>
      </div>
    </div>
  );
}
