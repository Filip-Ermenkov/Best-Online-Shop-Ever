"use client";

/**
 * Accessible admin image-upload field — the reusable widget that finally puts a
 * real upload UI behind the presigned-POST pipeline (roadmap item 46). One
 * component, three callers: the product editor uses it today; the category and
 * banner editors will reuse it unchanged (the `kind` prop selects the S3 key
 * folder). It manages an ordered list of images and reports them up via
 * `onChange` as `ImageDraft[]`; the parent maps those to the `{ s3Key, altText }`
 * array the `/admin/products` (and `/admin/categories`, `/admin/banners`) routes
 * already accept.
 *
 * Accessibility (WCAG 2.2 AA — the storefront-wide bar this admin section holds
 * to, see docs/ACCESSIBILITY.md):
 *   - SC 2.5.7 Dragging Movements: drag-and-drop is a *pure enhancement*. The
 *     always-present, keyboard-operable "Избери файл" button is the single-
 *     pointer path; the drop zone is additionally operable with Enter/Space.
 *     Image REORDERING likewise uses up/down buttons, never drag (matching
 *     CategoriesManager).
 *   - SC 4.1.3 Status Messages: a polite `role="status"` live region announces
 *     "качване…/качено/грешка" without moving focus.
 *   - SC 1.1.1 / 3.3.2: every control has a visible label or an `aria-label`;
 *     each thumbnail's <img> carries the admin-entered alt text.
 *
 * Security: the browser-declared `Content-Type` is never trusted as proof — the
 * assets-fn validator magic-byte-checks every upload server-side and deletes
 * spoofs. The client-side type/size checks here are a UX nicety (fail fast with
 * a clear message); the server is the authority. Previews bind only values that
 * originate from a trusted constructor (`URL.createObjectURL` for a just-picked
 * file, or `sanitizeImageUrl`'s canonicalised string for an existing CDN URL),
 * never a raw user string — the sanitizer-by-transformation pattern the rest of
 * the admin uses (see lib/utils.ts).
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sanitizeImageUrl } from "@/lib/utils";
import { uploadImage, waitUntilReady } from "@/lib/uploads/client";
import type { UploadError, UploadKind } from "@/lib/uploads/types";

/** One image under management: the key to persist + a render-safe preview. */
export interface ImageDraft {
  /** The S3 key to save on the entity (upload `storedKey`, or a manual key). */
  s3Key: string;
  /** Admin-authored alt text (accessibility + SEO). */
  altText: string;
  /**
   * A trusted, render-safe preview URL — a `blob:` object URL we created from a
   * just-picked file, or a `sanitizeImageUrl`-canonicalised CDN URL for an image
   * already saved on the entity. `null` when there is nothing safe to show
   * (e.g. a manually-entered key whose object isn't servable in this env yet).
   */
  previewUrl: string | null;
}

/**
 * The allowlist + size cap MIRROR the backend (lib/asset-upload.ts +
 * ASSET_UPLOAD_MAX_BYTES, default 10 MiB). They are a fail-fast UX convenience
 * only; the API re-validates and the S3 policy pins both, so a stale constant
 * here can never widen what is actually accepted.
 */
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;
const ACCEPT_ATTR = ALLOWED_IMAGE_TYPES.join(",");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function humanMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function uploadErrorMessage(err: UploadError): string {
  switch (err.kind) {
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    case "not_configured":
      return "Качването на файлове не е активирано на този сървър. Въведете S3 ключ ръчно.";
    case "validation":
      return err.detail ?? "Файлът е отхвърлен (тип или размер).";
    case "s3_rejected":
      return "Хранилището отказа файла. Опитайте отново.";
    case "network":
      return "Връзката пропадна по време на качването. Опитайте отново.";
    default:
      return err.detail ?? "Неуспешно качване.";
  }
}

/** Validate a picked file against the allowlist + cap. Returns an error or null. */
function validateFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return `Неподдържан формат „${file.type || "неизвестен"}“. Разрешени: JPEG, PNG, WebP, AVIF.`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `Файлът е твърде голям (макс. ${humanMb(MAX_IMAGE_BYTES)}).`;
  }
  return null;
}

/**
 * Return a render-safe <img src> value, or null. `blob:` URLs are ones WE
 * created via URL.createObjectURL (an opaque handle, not reflected markup);
 * everything else must canonicalise cleanly as http(s) through the shared
 * sanitizer. Binding this return value — not a raw input string — is the
 * sanitizer-by-transformation pattern the admin uses everywhere (lib/utils.ts).
 */
function safePreview(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("blob:")) return url;
  return sanitizeImageUrl(url);
}

interface ImageUploadFieldProps {
  /** Selects the S3 key folder: products | categories | banners. */
  kind: UploadKind;
  value: ImageDraft[];
  onChange: (next: ImageDraft[]) => void;
  /** Hard cap on the number of images (backend MAX_PRODUCT_IMAGES = 12). */
  max?: number;
  disabled?: boolean;
  /** Disambiguates input ids when several instances share a page. */
  idPrefix?: string;
}

export default function ImageUploadField({
  kind,
  value,
  onChange,
  max = 12,
  disabled = false,
  idPrefix = "img",
}: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Flipped true the first time the API answers 503 — reveals the manual-key
  // fallback so the editor stays usable before the pipeline is enabled.
  const [uploadsUnavailable, setUploadsUnavailable] = useState(false);
  const [manualKey, setManualKey] = useState("");

  // Track the object URLs we mint so we can revoke them and never leak. The
  // parent owns `value`, but only this component creates blob: previews.
  const objectUrls = useRef<Set<string>>(new Set());
  useEffect(() => {
    const created = objectUrls.current;
    return () => {
      for (const url of created) URL.revokeObjectURL(url);
      created.clear();
    };
  }, []);

  const remaining = Math.max(0, max - value.length);
  const canAddMore = remaining > 0 && !disabled;

  async function handleFiles(files: FileList | File[]): Promise<void> {
    const picked = Array.from(files);
    if (picked.length === 0) return;
    setError(null);

    // Respect the cap; take only as many as still fit.
    const slots = Math.max(0, max - value.length);
    const toProcess = picked.slice(0, slots);
    if (picked.length > slots) {
      setError(`Може да добавите най-много ${max} снимки. Излишните бяха пропуснати.`);
    }

    setUploading(true);
    // Accumulate locally so a multi-file batch reports up once per file without
    // racing on a stale `value` closure.
    let working = [...value];
    for (let i = 0; i < toProcess.length; i++) {
      const file = toProcess[i]!;
      const invalid = validateFile(file);
      if (invalid) {
        setError(invalid);
        setStatus(invalid);
        continue;
      }
      setStatus(`Качване на „${file.name}“… (${i + 1}/${toProcess.length})`);
      const result = await uploadImage(file, kind);
      if (result.ok) {
        // The S3 POST succeeded, but the assets-fn validator may still REJECT
        // the object (magic-byte/content mismatch) and delete it — e.g. a file
        // that is really a PNG/WebP/HEIC or is corrupt but carries a .jpg name.
        // Confirm it was actually promoted (servable) BEFORE we let the admin
        // save its key, so a rejected upload surfaces here instead of becoming a
        // silent broken image on the product later.
        setStatus(`Проверка на „${file.name}“…`);
        const ready = await waitUntilReady(result.value.storedKey, {
          tries: 12,
          intervalMs: 1000,
        });
        if (!ready) {
          setError(
            `„${file.name}“ беше отхвърлена при проверката — файлът не е валидно ` +
              `JPEG/PNG/WebP/AVIF изображение (или е повреден). Изберете друг файл.`,
          );
          setStatus(`„${file.name}“ беше отхвърлена.`);
          continue;
        }
        const objectUrl = URL.createObjectURL(file);
        objectUrls.current.add(objectUrl);
        working = [
          ...working,
          { s3Key: result.value.storedKey, altText: "", previewUrl: objectUrl },
        ];
        onChange(working);
        setStatus(`„${file.name}“ е качена.`);
      } else {
        if (result.error.kind === "not_configured") setUploadsUnavailable(true);
        const msg = uploadErrorMessage(result.error);
        setError(msg);
        setStatus(msg);
        // Stop the batch on a configuration/session error — retrying each file
        // would just repeat the same failure.
        if (result.error.kind === "not_configured" || result.error.kind === "not_admin") {
          break;
        }
      }
    }
    setUploading(false);
    // Allow re-picking the same filename (the input keeps its value otherwise).
    if (inputRef.current) inputRef.current.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || !canAddMore) return;
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  }

  function openPicker() {
    if (!disabled && canAddMore) inputRef.current?.click();
  }

  function updateAlt(index: number, altText: string) {
    onChange(value.map((img, i) => (i === index ? { ...img, altText } : img)));
  }

  function removeAt(index: number) {
    const removed = value[index];
    if (removed?.previewUrl && removed.previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(removed.previewUrl);
      objectUrls.current.delete(removed.previewUrl);
    }
    onChange(value.filter((_, i) => i !== index));
    setStatus("Снимката е премахната.");
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  }

  function addManualKey() {
    const key = manualKey.trim();
    if (!key || value.length >= max) return;
    onChange([...value, { s3Key: key, altText: "", previewUrl: null }]);
    setManualKey("");
    setStatus("Ключът е добавен.");
  }

  return (
    <div className="space-y-4">
      {/* The whole dashed zone is a single native <button> — keyboard- and
          pointer-operable for free (the WCAG 2.5.7 single-pointer path) and it
          also accepts a file DROP as a mouse-only enhancement. The real file
          <input> is a SIBLING (never nested inside the button), triggered
          programmatically — so the control is exactly one interactive element,
          and the button holds only phrasing content (spans/svg), never <p>/<div>. */}
      <button
        type="button"
        onClick={openPicker}
        disabled={!canAddMore || uploading}
        onDragOver={(e) => {
          e.preventDefault();
          if (canAddMore) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          "w-full rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          canAddMore
            ? "border-border hover:border-primary/60 cursor-pointer"
            : "border-border/60 opacity-60 cursor-not-allowed",
          dragOver ? "border-primary bg-primary/5" : "bg-muted/20",
        ].join(" ")}
      >
        <ImagePlus className="w-6 h-6 mx-auto text-muted-foreground" aria-hidden="true" />
        <span className="mt-2 block text-sm font-medium">
          Плъзнете снимки тук или ги изберете
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          JPEG, PNG, WebP или AVIF · до {humanMb(MAX_IMAGE_BYTES)} · максимум {max} снимки
        </span>
        <span className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium">
          {uploading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="w-4 h-4" aria-hidden="true" />
          )}
          {uploading ? "Качване…" : "Избери файл"}
        </span>
      </button>
      {/* The real control — a sibling of the button, kept out of the visual
          flow but in the DOM; triggered programmatically by the button above. */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files);
        }}
      />

      {/* Polite live region — announces upload progress/result to AT (SC 4.1.3). */}
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Manual-key fallback — shown once the API reports uploads are off, so the
          admin can still attach an image key (e.g. in local dev or before the
          pipeline is enabled). Mirrors the categories form's manual key field. */}
      {uploadsUnavailable && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <Label htmlFor={`${idPrefix}-manual-key`} className="text-xs">
            S3 ключ на изображение (ръчно)
          </Label>
          <div className="flex gap-2">
            <Input
              id={`${idPrefix}-manual-key`}
              value={manualKey}
              onChange={(e) => setManualKey(e.target.value)}
              placeholder="products/<uuid>.jpg"
              className="font-mono text-xs"
              disabled={value.length >= max}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addManualKey}
              disabled={!manualKey.trim() || value.length >= max}
            >
              Добави
            </Button>
          </div>
        </div>
      )}

      {/* The ordered image list. */}
      {value.length > 0 && (
        <ul className="space-y-2 list-none pl-0">
          {value.map((img, i) => {
            const src = safePreview(img.previewUrl);
            return (
              <li
                key={`${img.s3Key}-${i}`}
                className="flex items-start gap-3 rounded-md border border-border bg-white p-2"
              >
                <span className="text-xs text-muted-foreground font-mono pt-2 w-5 text-right flex-shrink-0">
                  {i + 1}.
                </span>
                <div className="w-16 h-16 rounded bg-muted overflow-hidden flex-shrink-0 flex items-center justify-center">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={img.altText || `Снимка ${i + 1}`} className="w-full h-full object-cover" />
                  ) : (
                    <ImagePlus className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <Label htmlFor={`${idPrefix}-alt-${i}`} className="text-xs text-muted-foreground">
                    Алтернативен текст (alt)
                  </Label>
                  <Input
                    id={`${idPrefix}-alt-${i}`}
                    value={img.altText}
                    onChange={(e) => updateAlt(i, e.target.value)}
                    placeholder="Кратко описание на снимката"
                    className="h-8 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground font-mono truncate" title={img.s3Key}>
                    {img.s3Key}
                  </p>
                </div>
                <div className="flex flex-col items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label={`Премести снимка ${i + 1} нагоре`}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === value.length - 1}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label={`Премести снимка ${i + 1} надолу`}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                  aria-label={`Премахни снимка ${i + 1}`}
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {value.length === 0 && !uploadsUnavailable && (
        <p className="text-xs text-muted-foreground">Все още няма добавени снимки.</p>
      )}
    </div>
  );
}
