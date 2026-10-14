/**
 * Definisi bingkai strip. Semua digambar di canvas oleh `src/lib/strip.ts`:
 * latar → pola → hiasan & stiker → foto → tulisan dan tanggal di footer.
 *
 * Menambah bingkai: tambahkan satu objek ke `FRAME_LIST`. Gambar/stiker sendiri diletakkan
 * di `public/frames/` lalu dirujuk lewat `stickers` (lihat README, bagian "Bingkai sendiri").
 */

export type FramePattern = "dots" | "stripes" | "gingham" | "grid";
export type FrameDecor = "hearts" | "stars" | "sparkles";
export type StickerAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "footer-left"
  | "footer-right";

export type FrameSticker = {
  /** Path gambar di `public/`, mis. "/frames/camera.svg". PNG/SVG dengan latar transparan. */
  src: string;
  anchor: StickerAnchor;
  /** Sisi terpanjang stiker dalam piksel pada skala penuh (sel foto = 600 px). */
  size: number;
};

export type FrameDef = {
  id: string;
  label: string;
  /** Warna latar. */
  bg: string;
  /** Warna tulisan, pola, dan hiasan. */
  fg: string;
  pattern?: FramePattern;
  decor?: FrameDecor;
  /** Mode film: latar gelap dengan lubang sprocket di kiri dan kanan. */
  film?: boolean;
  /** Margin di sekeliling foto dalam piksel pada skala penuh. Bawaan 48. */
  padding?: number;
  stickers?: FrameSticker[];
};

export const FRAME_LIST: FrameDef[] = [
  { id: "paper", label: "Kertas", bg: "#FBFBF7", fg: "#0E1440" },
  { id: "ink", label: "Tinta", bg: "#0E1440", fg: "#FBFBF7" },
  { id: "rose", label: "Mawar", bg: "#F6C9D0", fg: "#5A1E2B", decor: "hearts", padding: 64 },
  { id: "sage", label: "Daun", bg: "#CFE3C8", fg: "#1F3A22", pattern: "dots" },
  { id: "sky", label: "Langit", bg: "#C9DCF6", fg: "#16258A", decor: "stars", padding: 64 },
  { id: "picnic", label: "Piknik", bg: "#FFF3EF", fg: "#B3261E", pattern: "gingham", padding: 56 },
  { id: "film", label: "Film", bg: "#141414", fg: "#F2EDE4", film: true, padding: 88 },
  {
    id: "night",
    label: "Malam",
    bg: "#16258A",
    fg: "#FFE34D",
    pattern: "grid",
    decor: "sparkles",
    padding: 64,
  },
  {
    id: "studio",
    label: "Studio",
    bg: "#FFE34D",
    fg: "#0E1440",
    pattern: "stripes",
    padding: 96,
    stickers: [
      { src: "/frames/camera.svg", anchor: "top-left", size: 150 },
      { src: "/frames/star.svg", anchor: "top-right", size: 130 },
      { src: "/frames/heart.svg", anchor: "footer-right", size: 120 },
    ],
  },
];

export const FRAMES: Record<string, FrameDef> = Object.fromEntries(FRAME_LIST.map((f) => [f.id, f]));

export const DEFAULT_FRAME_ID = FRAME_LIST[0].id;

export function getFrame(id: string): FrameDef {
  return FRAMES[id] ?? FRAMES[DEFAULT_FRAME_ID];
}
