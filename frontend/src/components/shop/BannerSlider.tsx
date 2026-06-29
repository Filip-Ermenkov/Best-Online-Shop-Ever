"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { Banner } from "@/lib/types";
import { cn, sanitizeImageUrl } from "@/lib/utils";
import Link from "next/link";

interface BannerSliderProps {
  banners: Banner[];
}

const ADVANCE_MS = 5000;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Subscribe to the OS "reduce motion" setting without a setState-in-effect (the
 * project's react-hooks lint forbids that). `useSyncExternalStore` is the
 * sanctioned way to read a browser API: it's SSR-safe (the server snapshot is
 * `false`) and re-renders when the media query flips mid-session.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(REDUCED_MOTION_QUERY);
      mq.addEventListener("change", onStoreChange);
      return () => mq.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/**
 * Homepage hero carousel.
 *
 * Accessibility (WCAG 2.2 AA — the storefront-wide bar, docs/ACCESSIBILITY.md):
 *   - **SC 2.2.2 Pause, Stop, Hide (Level A).** Auto-rotation cycles for more
 *     than five seconds, so a control to stop it is mandatory. A visible
 *     pause/play button toggles it; rotation also pauses while the pointer is
 *     over the carousel or keyboard focus is inside it (hover/focus), and it
 *     never starts when the user prefers reduced motion (SC 2.3.3 / 2.2.2). This
 *     is the W3C APG "auto-rotating carousel with buttons" model.
 *   - **Announcements (SC 4.1.3).** The live region is `aria-live="off"` while
 *     rotating (so it doesn't chatter every 5 s) and `"polite"` once stopped, so
 *     a manual prev/next move is announced. (A live region never announces its
 *     INITIAL content, so the first slide on load is silent without any extra
 *     guard.) Each slide is a labelled group ("кадър N от M").
 *   - **Decorative image.** The title/subtitle render as real text, so the
 *     background image is `alt=""` (decorative) rather than duplicating the
 *     visible heading for screen-reader users.
 *
 * Performance: the first slide is the page's Largest Contentful Paint element,
 * so its image is `fetchPriority="high"` and eager (never lazy) — the 2026
 * Core-Web-Vitals guidance; the aspect-ratio box reserves space so there's no
 * layout shift (good CLS).
 */
export default function BannerSlider({ banners }: BannerSliderProps) {
  const active = banners.filter((b) => b.isActive);
  const [current, setCurrent] = useState(0);
  const [timerKey, setTimerKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // Keep the index in range if the active set shrinks (e.g. props change).
  const safeIndex = active.length > 0 ? Math.min(current, active.length - 1) : 0;

  const multiple = active.length > 1;
  const autoRotating = multiple && !paused && !interacting && !reducedMotion;

  const goTo = (index: number) => {
    setCurrent(((index % active.length) + active.length) % active.length);
    setTimerKey((k) => k + 1); // restart the dwell timer on manual navigation
  };
  const next = () => goTo(safeIndex + 1);
  const prev = () => goTo(safeIndex - 1);

  useEffect(() => {
    if (!autoRotating) return;
    // setState lives in the interval CALLBACK (an external event), not the
    // effect body — the pattern react-hooks/set-state-in-effect allows.
    const timer = setInterval(() => {
      setCurrent((c) => (c + 1) % active.length);
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  }, [autoRotating, active.length, timerKey]);

  if (active.length === 0) return null;

  const banner = active[safeIndex]!;
  const imageSrc = sanitizeImageUrl(banner.imageUrl);
  const slideLabel = `${safeIndex + 1} от ${active.length}`;

  return (
    <section
      aria-roledescription="карусел"
      aria-label="Промоционални банери"
      className="relative overflow-hidden bg-[oklch(0.18_0.02_270)] aspect-[4/3] sm:aspect-[16/5] lg:aspect-[16/4]"
      onMouseEnter={() => setInteracting(true)}
      onMouseLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={() => setInteracting(false)}
    >
      {/* Slide group — a labelled region so AT users hear "кадър N от M".
          A real positioned box (not display:contents) so the group stays in the
          accessibility tree, and it doubles as the containing block for the
          absolutely-positioned image/overlays/content below. */}
      <div
        aria-roledescription="кадър"
        aria-label={slideLabel}
        className="absolute inset-0"
      >
        {/* Decorative background image — the heading/subtitle below are the real
            text, so the image carries an empty alt to avoid duplication. */}
        {imageSrc && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={banner.id}
            src={imageSrc}
            alt=""
            fetchPriority={safeIndex === 0 ? "high" : "auto"}
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover opacity-60 transition-opacity duration-500"
          />
        )}

        {/* Gradient overlays — keep the text readable over any image. */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-center h-full max-w-7xl mx-auto px-6 sm:px-12 py-6">
          {banner.title && (
            <h2 className="text-white font-bold text-2xl sm:text-4xl drop-shadow-sm">
              {banner.title}
            </h2>
          )}
          {banner.subtitle && (
            <p className="text-white/90 mt-2 text-sm sm:text-lg">{banner.subtitle}</p>
          )}
          {banner.linkUrl && (
            <Link
              href={banner.linkUrl}
              className="mt-5 inline-flex items-center gap-2 bg-[oklch(0.73_0.10_75)] text-[oklch(0.18_0.02_270)] font-semibold px-5 py-2.5 rounded-md w-fit hover:bg-[oklch(0.78_0.10_75)] transition-colors text-sm"
            >
              {banner.linkLabel ?? "Разгледай"}
            </Link>
          )}
        </div>
      </div>

      {/* Live region: silent while rotating, polite once stopped (SC 4.1.3). The
          initial content is never announced (live regions ignore their starting
          text), so the first slide on load stays silent. */}
      <div aria-live={autoRotating ? "off" : "polite"} className="sr-only">
        {`Кадър ${slideLabel}${banner.title ? `: ${banner.title}` : ""}`}
      </div>

      {multiple && (
        <>
          {/* Pause / play — the SC 2.2.2 stop control. Hidden when reduced motion
              is preferred (there is nothing auto-rotating to pause). */}
          {!reducedMotion && (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="absolute top-3 right-3 z-20 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
              aria-label={paused ? "Възпроизведи въртенето" : "Спри въртенето"}
              aria-pressed={paused}
            >
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={prev}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
            aria-label="Предишен банер"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={next}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
            aria-label="Следващ банер"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Dots — each button is a >=24x24 hit target (WCAG 2.5.8) with the
              small visual indicator centred inside as a <span>. */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1">
            {active.map((b, i) => (
              <button
                key={b.id}
                onClick={() => goTo(i)}
                className="group flex h-6 min-w-6 items-center justify-center"
                aria-label={`Банер ${i + 1}`}
                aria-current={i === safeIndex ? "true" : undefined}
              >
                <span
                  className={cn(
                    "block h-1.5 rounded-full transition-all duration-300",
                    i === safeIndex
                      ? "bg-[oklch(0.73_0.10_75)] w-6"
                      : "bg-white/50 group-hover:bg-white/80 w-1.5",
                  )}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
