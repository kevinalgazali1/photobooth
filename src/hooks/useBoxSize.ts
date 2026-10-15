"use client";

import { useEffect, useState, type RefObject } from "react";

export type BoxSize = { width: number; viewportWidth: number; viewportHeight: number };

/** Lebar elemen + ukuran viewport, diperbarui saat ukuran berubah (rotasi HP, resize jendela). */
export function useBoxSize(ref: RefObject<HTMLElement | null>): BoxSize {
  const [size, setSize] = useState<BoxSize>({ width: 0, viewportWidth: 0, viewportHeight: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setSize((prev) => {
        const next = {
          width: el.clientWidth,
          viewportWidth: window.innerWidth,
          viewportHeight: window.visualViewport?.height ?? window.innerHeight,
        };
        return prev.width === next.width &&
          prev.viewportWidth === next.viewportWidth &&
          prev.viewportHeight === next.viewportHeight
          ? prev
          : next;
      });
    // ResizeObserver langsung memanggil callback sekali saat mulai mengamati.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);

  return size;
}
