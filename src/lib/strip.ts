import { getFrame, type FrameDef, type FrameSticker } from "./frames";
import type { FilterId, FrameId } from "./types";

export const FILTERS: Record<FilterId, { label: string; css: string }> = {
  none: { label: "Asli", css: "none" },
  bw: { label: "Hitam putih", css: "grayscale(1) contrast(1.1)" },
  vintage: { label: "Vintage", css: "sepia(0.55) contrast(1.05) saturate(1.1)" },
  warm: { label: "Hangat", css: "saturate(1.2) brightness(1.04)" },
};

// Ukuran dasar (skala 1). Untuk N besar semuanya diperkecil supaya sisi terpanjang PNG ≤ MAX_SIDE.
const CELL_W = 600;
const CELL_H = 450;
const PAD = 48;
const GAP = 20;
const PANEL_GAP = 36;
const FOOTER = 180;
const MAX_SIDE = 4000;

/** Jumlah kolom dalam satu panel untuk N orang. Dipakai juga oleh grid kamera. */
export function columnsFor(people: number): number {
  if (people <= 3) return Math.max(1, people);
  if (people === 4) return 2;
  if (people <= 6) return 3;
  return 4;
}

type Rect = { x: number; y: number; w: number; h: number };

export type StripLayout = {
  width: number;
  height: number;
  /** Faktor skala terhadap ukuran dasar. */
  unit: number;
  pad: number;
  footerTop: number;
  footerHeight: number;
  /** cells[jepretan][orang] */
  cells: Rect[][];
};

export function stripLayout(people: number, shots: number, frame: FrameDef, scale = 1): StripLayout {
  const n = Math.max(1, people);
  const cols = columnsFor(n);
  const rows = Math.ceil(n / cols);
  const pad = frame.padding ?? PAD;

  const contentW = cols * CELL_W + (cols - 1) * GAP;
  const panelH = rows * CELL_H + (rows - 1) * GAP;
  const baseW = pad * 2 + contentW;
  const baseH = pad + shots * panelH + (shots - 1) * PANEL_GAP + FOOTER;

  const unit = Math.min(1, MAX_SIDE / Math.max(baseW, baseH)) * scale;
  const u = (v: number) => Math.round(v * unit);

  const cells: Rect[][] = [];
  for (let shot = 0; shot < shots; shot++) {
    const panelTop = pad + shot * (panelH + PANEL_GAP);
    const row: Rect[] = [];
    for (let p = 0; p < n; p++) {
      const r = Math.floor(p / cols);
      const c = p % cols;
      // Baris terakhir yang tidak penuh diletakkan di tengah.
      const inRow = Math.min(cols, n - r * cols);
      const rowW = inRow * CELL_W + (inRow - 1) * GAP;
      const x0 = pad + (contentW - rowW) / 2;
      const x = u(x0 + c * (CELL_W + GAP));
      const y = u(panelTop + r * (CELL_H + GAP));
      row.push({ x, y, w: u(x0 + c * (CELL_W + GAP) + CELL_W) - x, h: u(panelTop + r * (CELL_H + GAP) + CELL_H) - y });
    }
    cells.push(row);
  }

  return {
    width: u(baseW),
    height: u(baseH),
    unit,
    pad: pad * unit,
    footerTop: u(baseH - FOOTER),
    footerHeight: u(baseH) - u(baseH - FOOTER),
    cells,
  };
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Foto tidak bisa dibaca."));
    };
    img.src = url;
  });
}

const stickerCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadSticker(src: string): Promise<HTMLImageElement | null> {
  let cached = stickerCache.get(src);
  if (!cached) {
    cached = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        stickerCache.delete(src); // coba lagi lain kali
        resolve(null);
      };
      img.src = src;
    });
    stickerCache.set(src, cached);
  }
  return cached;
}

/** Filter diterapkan per piksel supaya hasilnya sama di semua browser (termasuk Safari lama). */
function applyFilter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, filter: FilterId) {
  if (filter === "none" || w <= 0 || h <= 0) return;
  const image = ctx.getImageData(x, y, w, h);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (filter === "bw") {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const c = (l - 128) * 1.1 + 128;
      d[i] = d[i + 1] = d[i + 2] = c;
    } else if (filter === "vintage") {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      d[i] = r * 0.45 + sr * 0.55;
      d[i + 1] = g * 0.45 + sg * 0.55;
      d[i + 2] = b * 0.45 + sb * 0.55;
    } else if (filter === "warm") {
      d[i] = r * 1.08 + 6;
      d[i + 1] = g * 1.02 + 2;
      d[i + 2] = b * 0.9;
    }
  }
  ctx.putImageData(image, x, y);
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.naturalWidth - sw) / 2;
  const sy = (img.naturalHeight - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function readFontVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ── Pola latar ───────────────────────────────────────────────────

function drawPattern(ctx: CanvasRenderingContext2D, frame: FrameDef, w: number, h: number, unit: number) {
  if (!frame.pattern) return;
  ctx.save();
  ctx.fillStyle = frame.fg;
  ctx.strokeStyle = frame.fg;

  if (frame.pattern === "dots") {
    const step = 28 * unit;
    const r = 4 * unit;
    ctx.globalAlpha = 0.2;
    for (let row = 0, y = step / 2; y < h + step; row++, y += step) {
      for (let x = row % 2 ? step : step / 2; x < w + step; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (frame.pattern === "stripes") {
    const step = 44 * unit;
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 18 * unit;
    ctx.beginPath();
    for (let x = -h; x < w + h; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x + h, h);
    }
    ctx.stroke();
  } else if (frame.pattern === "gingham") {
    const step = 56 * unit;
    const band = 28 * unit;
    ctx.globalAlpha = 0.14;
    for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, band);
    for (let x = 0; x < w; x += step) ctx.fillRect(x, 0, band, h);
  } else if (frame.pattern === "grid") {
    const step = 40 * unit;
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = Math.max(1, 2 * unit);
    ctx.beginPath();
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ── Hiasan: bentuk dari path (bukan emoji, supaya sama di semua perangkat) ───

/** Bentuk dengan ukuran ±1 berpusat di (0, 0). */
function shapePath(kind: NonNullable<FrameDef["decor"]>): Path2D {
  const p = new Path2D();
  if (kind === "hearts") {
    p.moveTo(0, 0.9);
    p.bezierCurveTo(-0.6, 0.45, -1, 0.1, -1, -0.3);
    p.bezierCurveTo(-1, -0.75, -0.45, -1, 0, -0.55);
    p.bezierCurveTo(0.45, -1, 1, -0.75, 1, -0.3);
    p.bezierCurveTo(1, 0.1, 0.6, 0.45, 0, 0.9);
  } else if (kind === "stars") {
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 1 : 0.42;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      if (i === 0) p.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else p.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
  } else {
    // kilau empat sudut
    p.moveTo(0, -1);
    p.quadraticCurveTo(0.12, -0.12, 1, 0);
    p.quadraticCurveTo(0.12, 0.12, 0, 1);
    p.quadraticCurveTo(-0.12, 0.12, -1, 0);
    p.quadraticCurveTo(-0.12, -0.12, 0, -1);
  }
  p.closePath();
  return p;
}

/** PRNG deterministik supaya posisi hiasan sama persis di semua browser. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function drawDecor(ctx: CanvasRenderingContext2D, frame: FrameDef, layout: StripLayout, avoid: Rect[]) {
  if (!frame.decor) return;
  const { width, height, unit } = layout;
  const shape = shapePath(frame.decor);
  // Disebar dalam ukuran dasar lalu diskalakan, supaya pola sama untuk thumbnail dan hasil akhir.
  const rand = mulberry32(hash(`${frame.id}:${layout.cells.length}:${layout.cells[0]?.length ?? 0}`));
  const placed: { x: number; y: number; r: number }[] = [];
  const target = Math.round((width * height) / (unit * unit) / 26000);

  const blocked = (x: number, y: number, r: number) =>
    avoid.some((a) => x + r > a.x && x - r < a.x + a.w && y + r > a.y && y - r < a.y + a.h) ||
    x - r < 0 ||
    y - r < 0 ||
    x + r > width ||
    y + r > height ||
    placed.some((p) => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 1.4);

  for (let tries = 0; tries < 1500 && placed.length < target; tries++) {
    const r = (9 + rand() * 9) * unit;
    const x = rand() * width;
    const y = rand() * height;
    const rot = (rand() - 0.5) * 0.9;
    const alpha = 0.55 + rand() * 0.4;
    if (blocked(x, y, r)) continue;
    placed.push({ x, y, r });
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(r, r);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = frame.fg;
    ctx.fill(shape);
    ctx.restore();
  }
}

function drawSprockets(ctx: CanvasRenderingContext2D, frame: FrameDef, layout: StripLayout) {
  const { width, height, pad } = layout;
  const holeW = pad * 0.36;
  const holeH = pad * 0.26;
  const step = pad * 0.52;
  const radius = holeH * 0.28;
  ctx.save();
  ctx.fillStyle = frame.fg;
  ctx.globalAlpha = 0.9;
  for (let y = step * 0.4; y + holeH < height; y += step) {
    for (const cx of [pad / 2, width - pad / 2]) {
      ctx.beginPath();
      ctx.roundRect(cx - holeW / 2, y, holeW, holeH, radius);
      ctx.fill();
    }
  }
  ctx.restore();
}

type PlacedSticker = { img: HTMLImageElement; x: number; y: number; w: number; h: number; anchor: FrameSticker["anchor"] };

async function placeStickers(frame: FrameDef, layout: StripLayout): Promise<PlacedSticker[]> {
  if (!frame.stickers?.length) return [];
  const { width, height, unit, pad, footerTop, footerHeight } = layout;
  const inset = pad * 0.12;
  const result: PlacedSticker[] = [];
  for (const sticker of frame.stickers) {
    const img = await loadSticker(sticker.src);
    if (!img || !img.naturalWidth || !img.naturalHeight) continue;
    const ratio = img.naturalWidth / img.naturalHeight;
    const size = sticker.size * unit;
    const w = ratio >= 1 ? size : size * ratio;
    const h = ratio >= 1 ? size / ratio : size;
    const left = inset;
    const right = width - inset - w;
    const top = inset;
    const bottom = height - inset - h;
    const footerY = footerTop + (footerHeight - h) / 2;
    const pos: Record<FrameSticker["anchor"], [number, number]> = {
      "top-left": [left, top],
      "top-right": [right, top],
      "bottom-left": [left, bottom],
      "bottom-right": [right, bottom],
      "footer-left": [pad, footerY],
      "footer-right": [width - pad - w, footerY],
    };
    const [x, y] = pos[sticker.anchor];
    result.push({ img, x, y, w, h, anchor: sticker.anchor });
  }
  return result;
}

// ── Susun strip ──────────────────────────────────────────────────

export type StripInput = {
  /** Jumlah orang dalam satu panel. */
  people: number;
  /** Jumlah jepretan (panel yang ditumpuk ke bawah). */
  shots: number;
  /** photos[orang][jepretan]; null/undefined digambar sebagai kotak kosong. */
  photos: (Blob | null | undefined)[][];
  frame: FrameId;
  filter: FilterId;
  caption: string;
  date?: Date;
  /** Skala tambahan, mis. 0.08 untuk thumbnail. */
  scale?: number;
};

export async function renderStrip(input: StripInput): Promise<HTMLCanvasElement> {
  const frame = getFrame(input.frame);
  const layout = stripLayout(input.people, input.shots, frame, input.scale ?? 1);
  const { width, height, unit, pad, footerTop } = layout;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas tidak didukung.");

  // 1. latar
  ctx.fillStyle = frame.bg;
  ctx.fillRect(0, 0, width, height);

  // 2. pola
  drawPattern(ctx, frame, width, height, unit);

  // 3. hiasan dan stiker (foto digambar di atasnya, jadi hanya terlihat di margin dan footer)
  if (frame.film) drawSprockets(ctx, frame, layout);
  const stickers = await placeStickers(frame, layout);
  const captionBox: Rect = {
    x: width * 0.2,
    y: footerTop + 20 * unit,
    w: width * 0.6,
    h: 140 * unit,
  };
  drawDecor(ctx, frame, layout, [...layout.cells.flat(), captionBox, ...stickers]);
  for (const s of stickers) ctx.drawImage(s.img, s.x, s.y, s.w, s.h);

  // 4. foto
  for (let shot = 0; shot < layout.cells.length; shot++) {
    const row = layout.cells[shot];
    for (let person = 0; person < row.length; person++) {
      const { x, y, w, h } = row[person];
      const blob = input.photos[person]?.[shot];
      if (blob) {
        try {
          const img = await loadImage(blob);
          drawCover(ctx, img, x, y, w, h);
          applyFilter(ctx, x, y, w, h, input.filter);
          continue;
        } catch {
          /* gambar kotak kosong di bawah */
        }
      }
      ctx.fillStyle = frame.bg;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = frame.fg;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    }
  }

  // 5. tulisan dan tanggal
  const display = readFontVar("--font-display", "Impact, sans-serif");
  const body = readFontVar("--font-body", "system-ui, sans-serif");
  const captionFont = `900 ${76 * unit}px ${display}`;
  const dateFont = `500 ${28 * unit}px ${body}`;
  try {
    await Promise.all([document.fonts?.load(captionFont), document.fonts?.load(dateFont)]);
  } catch {
    /* pakai font cadangan */
  }

  const footerStickers = stickers.filter((s) => s.anchor.startsWith("footer"));
  const reserved = footerStickers.reduce((m, s) => Math.max(m, s.w), 0);
  const maxText = Math.max(40 * unit, width - pad * 2 - (reserved ? (reserved + 16 * unit) * 2 : 0));

  ctx.fillStyle = frame.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = captionFont;
  ctx.fillText(input.caption.trim() || "kita", width / 2, footerTop + 96 * unit, maxText);

  const date = (input.date ?? new Date()).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  ctx.font = dateFont;
  ctx.globalAlpha = 0.7;
  ctx.fillText(date, width / 2, footerTop + 140 * unit, maxText);
  ctx.globalAlpha = 1;

  return canvas;
}

/**
 * Menyusun strip foto: satu panel per jepretan, berisi foto semua orang sesuai urutan `photos`.
 * Semua browser memanggil fungsi ini dengan urutan yang sama, jadi hasilnya identik.
 */
export async function composeStrip(input: StripInput): Promise<Blob> {
  const canvas = await renderStrip(input);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gagal membuat strip."))),
      "image/png",
    );
  });
}
