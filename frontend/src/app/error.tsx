"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-6">
        <AlertTriangle className="w-8 h-8 text-destructive" />
      </div>
      <h1 className="text-2xl font-bold mb-2">Нещо се обърка</h1>
      <p className="text-muted-foreground max-w-sm mb-8">
        Възникна неочаквана грешка. Опитайте отново или се свържете с нас на{" "}
        <a href="mailto:contact@duda1.bg" className="text-primary hover:underline">contact@duda1.bg</a>.
      </p>
      <div className="flex gap-3">
        <Button onClick={reset} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Опитай отново
        </Button>
        <ButtonLink variant="outline" className="gap-2" href="/">
          <Home className="w-4 h-4" /> Начало
        </ButtonLink>
      </div>
    </div>
  );
}
