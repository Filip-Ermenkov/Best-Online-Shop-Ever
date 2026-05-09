"use client";

import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Banner } from "@/lib/types";
import { cn } from "@/lib/utils";
import Link from "next/link";

interface BannerSliderProps {
  banners: Banner[];
}

export default function BannerSlider({ banners }: BannerSliderProps) {
  const active = banners.filter((b) => b.isActive);
  const [current, setCurrent] = useState(0);
  const [timerKey, setTimerKey] = useState(0);

  const goTo = (index: number) => {
    setCurrent(index);
    setTimerKey((k) => k + 1); // restart timer on manual navigation
  };

  const next = () => goTo((current + 1) % active.length);
  const prev = () => goTo((current - 1 + active.length) % active.length);

  // Auto-advance every 5s — resets when timerKey changes
  useEffect(() => {
    if (active.length <= 1) return;
    const timer = setInterval(() => {
      setCurrent((c) => (c + 1) % active.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [timerKey, active.length]);

  if (active.length === 0) return null;

  const banner = active[current];

  return (
    <div className="relative overflow-hidden bg-[oklch(0.18_0.02_270)] aspect-[4/3] sm:aspect-[16/5] lg:aspect-[16/4]">
      {/* Image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={banner.id}
        src={banner.imageUrl}
        alt={banner.title}
        className="absolute inset-0 w-full h-full object-cover opacity-60 transition-opacity duration-500"
      />

      {/* Gradient overlay — ensures text is always readable */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-center h-full max-w-7xl mx-auto px-6 sm:px-12 py-6">
        <h2 className="text-white font-bold text-2xl sm:text-4xl drop-shadow-sm">{banner.title}</h2>
        {banner.subtitle && (
          <p className="text-white/90 mt-2 text-sm sm:text-lg">{banner.subtitle}</p>
        )}
        {banner.linkUrl && banner.linkLabel && (
          <Link
            href={banner.linkUrl}
            className="mt-5 inline-flex items-center gap-2 bg-[oklch(0.73_0.10_75)] text-[oklch(0.18_0.02_270)] font-semibold px-5 py-2.5 rounded-md w-fit hover:bg-[oklch(0.78_0.10_75)] transition-colors text-sm"
          >
            {banner.linkLabel}
          </Link>
        )}
      </div>

      {/* Prev / Next */}
      {active.length > 1 && (
        <>
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

          {/* Dots */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-2">
            {active.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-300",
                  i === current
                    ? "bg-[oklch(0.73_0.10_75)] w-6"
                    : "bg-white/50 hover:bg-white/80 w-1.5"
                )}
                aria-label={`Банер ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
