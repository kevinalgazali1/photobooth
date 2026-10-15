"use client";

import { useEffect, useRef } from "react";
import { paintDecorTile } from "@/lib/strip";

type Props = {
  frameId: string;
  caption: string;
  /** Nomor jepretan, mis. "2/3". */
  label: string;
  width: number;
  aspect: number;
};

/**
 * Tile hiasan di slot kosong grid kamera live. Digambar oleh fungsi yang sama dengan canvas strip,
 * jadi yang terlihat saat foto sama dengan hasilnya.
 */
export function DecorTile({ frameId, caption, label, width, aspect }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const height = width / aspect;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    void paintDecorTile(canvas, frameId, caption, label);
  }, [frameId, caption, label, width, height]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="block"
      style={{ width, height }}
    />
  );
}
