"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";

/**
 * Renders a one-shot success banner when the URL carries
 * `?account-deleted=success`. The /account/delete page redirects here on a
 * successful GDPR Art. 17 erasure; we want to confirm to the user that the
 * destructive action completed (and that the confirmation email is on the
 * way) before they navigate away.
 *
 * Lifecycle:
 *   - First render reads the query string via the useState initializer
 *     (NOT inside an effect — that would trip
 *     react-hooks/set-state-in-effect, the React 19 rule that
 *     discourages setState-from-effect cascades). The initializer is a
 *     pure read of the current useSearchParams() snapshot, so this is a
 *     normal useState initialisation rather than the setState-in-effect
 *     anti-pattern.
 *   - An effect then syncs the URL BACK to the external world: it strips
 *     the `?account-deleted=success` query param via router.replace() so
 *     a refresh / back-forward doesn't re-trigger the banner. This
 *     effect touches ONLY the external system (the URL); it does NOT
 *     call setState, which is the shape the rule explicitly endorses.
 *   - The dismiss button toggles local state — no effect involved.
 *
 * Subtle: after the URL strip, `params` changes and the effect re-fires,
 * but the `if` guard short-circuits because the query param is gone. The
 * banner stays visible because `visible` is local state, decoupled from
 * the URL after the initial read.
 *
 * Why a Client Component and not a server-rendered banner?
 *   The homepage is a Server Component (PPR-friendly) that fetches the
 *   category tree and featured products at build/revalidate time.
 *   Reading searchParams there would force dynamic rendering for every
 *   visit. Pushing this into a tiny CSR island keeps the home page
 *   statically generated.
 */
export default function AccountDeletedBanner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Initialise from the URL exactly once at mount. The initializer
  // function is pure — calling .get() on the search-params snapshot has
  // no side effect.
  const [visible, setVisible] = useState(
    () => params.get("account-deleted") === "success",
  );

  // Sync React state back to the URL (external system): strip the
  // ?account-deleted param so a refresh doesn't re-trigger the banner.
  // No setState in this effect — visible is already correctly seeded
  // from the URL by the useState initializer above.
  useEffect(() => {
    if (params.get("account-deleted") === "success") {
      const next = new URLSearchParams(params.toString());
      next.delete("account-deleted");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [params, router, pathname]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="max-w-7xl mx-auto px-4 pt-4"
    >
      <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4">
        <CheckCircle2 className="w-5 h-5 text-green-700 mt-0.5 shrink-0" />
        <div className="flex-1 text-sm text-green-800">
          <p className="font-semibold">Акаунтът Ви беше изтрит успешно.</p>
          <p className="mt-1">
            Изпратихме потвърждаващ имейл на адреса Ви. Историята на
            поръчките Ви е запазена псевдонимизирана съгласно
            10-годишния срок на Закона за счетоводството.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label="Скрий съобщението"
          className="text-green-700 hover:text-green-900"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
