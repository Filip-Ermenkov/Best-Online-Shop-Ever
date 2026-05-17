import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPrice(amount: number): string {
  return new Intl.NumberFormat("bg-BG", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format an integer-cents value as a localised price string.
 *
 * The cart slice (and everything downstream of the API) deals in priceCents
 * to avoid floating-point drift across reducers. UI rendering happens here.
 */
export function formatCents(amountCents: number): string {
  return formatPrice(amountCents / 100);
}

export function formatDate(dateString: string): string {
  return new Intl.DateTimeFormat("bg-BG", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(dateString));
}

// Bulgarian → Latin transliteration map (official BDS ISO 9 / passport-style mix)
const BG_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ж: "Zh", З: "Z",
  И: "I", Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P",
  Р: "R", С: "S", Т: "T", У: "U", Ф: "F", Х: "H", Ц: "Ts", Ч: "Ch",
  Ш: "Sh", Щ: "Sht", Ъ: "A", Ь: "Y", Ю: "Yu", Я: "Ya",
};

/**
 * Return true only if `url` is a string the browser will treat as a
 * plain HTTP(S) image URL — safe to bind to <img src> without risk of
 * `javascript:`, `data:`, `vbscript:`, or `file:` scheme abuse.
 *
 * Why this exists: CodeQL flags any path from user input (an <Input>'s
 * value) to a JSX `src` attribute as a potential XSS sink, on the basis
 * that some schemes (historically) execute script in the page context.
 * Modern browsers DO block `javascript:` in <img src> in practice, but
 * defence-in-depth is cheaper than relying on every future browser
 * keeping that mitigation. Validating the scheme is a textbook fix
 * (CWE-79 / CWE-601 — open-redirect-style mitigation) and is the
 * pattern CodeQL's data-flow tracker recognises as a sanitizer,
 * which is what closes the alert.
 *
 * Returns false on:
 *   - empty string, null, undefined, non-string input
 *   - malformed URL (URL constructor throws)
 *   - any protocol other than http: or https:
 *     (notably: javascript:, data:, vbscript:, file:, blob:,
 *     about:, view-source:)
 *
 * Note: this does NOT validate that the URL actually serves an image.
 * That's a different concern (handled by the browser falling back to
 * the alt text, or by an onError handler at the call site).
 */
export function isSafeImageUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Convert Bulgarian text to a URL-friendly lowercase slug */
export function slugify(text: string): string {
  return text
    .split("")
    .map((ch) => BG_TO_LATIN[ch] ?? ch)
    .join("")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // strip anything non-alphanumeric
    .replace(/\s+/g, "-") // spaces → dashes
    .replace(/-+/g, "-") // collapse multiple dashes
    .replace(/^-|-$/g, ""); // trim leading/trailing dashes
}
