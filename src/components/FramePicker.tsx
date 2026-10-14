"use client";

import { useEffect, useState } from "react";
import { FRAME_LIST } from "@/lib/frames";
import { renderStrip, stripLayout } from "@/lib/strip";

type Props = {
  people: number;
  shots: number;
  caption: string;
  value: string;
  disabled?: boolean;
  onChange: (frameId: string) => void;
};

/** Sisi terpanjang thumbnail (px). Ditampilkan setengahnya supaya tajam di layar retina. */
const THUMB_SIDE = 192;

/**
 * Pemilih bingkai dengan thumbnail asli: hasil `renderStrip` berisi kotak kosong,
 * sesuai jumlah orang dan jumlah jepretan saat ini.
 */
export function FramePicker({ people, shots, caption, value, disabled, onChange }: Props) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const entries = await Promise.all(
        FRAME_LIST.map(async (frame) => {
          const base = stripLayout(people, shots, frame);
          const scale = THUMB_SIDE / Math.max(base.width, base.height);
          try {
            const canvas = await renderStrip({
              people,
              shots,
              photos: [],
              frame: frame.id,
              filter: "none",
              caption,
              scale,
            });
            return [frame.id, canvas.toDataURL("image/png")] as const;
          } catch {
            return [frame.id, ""] as const;
          }
        }),
      );
      if (!cancelled) setThumbs(Object.fromEntries(entries));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [people, shots, caption]);

  return (
    <div className="flex flex-wrap gap-3">
      {FRAME_LIST.map((frame) => (
        <button
          key={frame.id}
          type="button"
          aria-pressed={value === frame.id}
          disabled={disabled}
          onClick={() => onChange(frame.id)}
          className="group flex flex-col items-center gap-1.5 rounded-xl border-2 border-paper/20 p-2 transition-colors hover:border-paper aria-pressed:border-flash aria-pressed:bg-flash/10 disabled:opacity-50"
        >
          <span className="grid h-24 min-w-14 place-items-center">
            {thumbs[frame.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbs[frame.id]} alt="" className="max-h-24 max-w-24 shadow-md" />
            ) : (
              <span className="block h-20 w-14 shadow-md" style={{ backgroundColor: frame.bg }} />
            )}
          </span>
          <span className="text-xs font-medium group-aria-pressed:font-bold group-aria-pressed:text-flash">
            {frame.label}
          </span>
        </button>
      ))}
    </div>
  );
}
