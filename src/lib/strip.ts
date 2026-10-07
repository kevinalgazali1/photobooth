import type { FilterId, FrameId } from "./types";

export const FRAMES: Record<FrameId, { label: string; bg: string; fg: string }> = {
  paper: { label: "Kertas", bg: "#FBFBF7", fg: "#0E1440" },
  ink: { label: "Tinta", bg: "#0E1440", fg: "#FBFBF7" },
  rose: { label: "Mawar", bg: "#F6C9D0", fg: "#5A1E2B" },
  sage: { label: "Daun", bg: "#CFE3C8", fg: "#1F3A22" },
  sky: { label: "Langit", bg: "#C9DCF6", fg: "#16258A" },
};

export const FILTERS: Record<FilterId, { label: string; css: string }> = {
  none: { label: "Asli", css: "none" },
  bw: { label: "Hitam putih", css: "grayscale(1) contrast(1.1)" },
  vintage: { label: "Vintage", css: "sepia(0.55) contrast(1.05) saturate(1.1)" },
  warm: { label: "Hangat", css: "saturate(1.2) brightness(1.04)" },
};

const CELL_W = 600;
const CELL_H = 450;
const PAD = 48;
const GAP = 20;
const FOOTER = 180;

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

/** Filter diterapkan per piksel supaya hasilnya sama di semua browser (termasuk Safari lama). */
function applyFilter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, filter: FilterId) {
  if (filter === "none") return;
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

export type StripInput = {
  left: (Blob | null)[];
  right: (Blob | null)[];
  frame: FrameId;
  filter: FilterId;
  caption: string;
  date?: Date;
};

/**
 * Menyusun strip foto: tiap baris berisi foto orang pertama (kiri) dan kedua (kanan).
 * Kedua browser memanggil fungsi ini dengan urutan yang sama, jadi hasilnya identik.
 */
export async function composeStrip(input: StripInput): Promise<Blob> {
  const rows = Math.max(input.left.length, input.right.length);
  const theme = FRAMES[input.frame];

  const width = PAD * 2 + CELL_W * 2 + GAP;
  const height = PAD + rows * CELL_H + (rows - 1) * GAP + FOOTER;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas tidak didukung.");

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  for (let row = 0; row < rows; row++) {
    const y = PAD + row * (CELL_H + GAP);
    const cells: [Blob | null | undefined, number][] = [
      [input.left[row], PAD],
      [input.right[row], PAD + CELL_W + GAP],
    ];
    for (const [blob, x] of cells) {
      if (blob) {
        try {
          const img = await loadImage(blob);
          drawCover(ctx, img, x, y, CELL_W, CELL_H);
          applyFilter(ctx, x, y, CELL_W, CELL_H, input.filter);
          continue;
        } catch {
          /* gambar kotak kosong di bawah */
        }
      }
      ctx.fillStyle = theme.fg;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x, y, CELL_W, CELL_H);
      ctx.globalAlpha = 1;
    }
  }

  if (document.fonts?.ready) await document.fonts.ready;
  const display = readFontVar("--font-display", "Impact, sans-serif");
  const body = readFontVar("--font-body", "system-ui, sans-serif");

  const footerTop = height - FOOTER;
  ctx.fillStyle = theme.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 76px ${display}`;
  ctx.fillText(input.caption.trim() || "kita", width / 2, footerTop + 96, width - PAD * 2);

  const date = (input.date ?? new Date()).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  ctx.font = `500 28px ${body}`;
  ctx.globalAlpha = 0.7;
  ctx.fillText(date, width / 2, footerTop + 140);
  ctx.globalAlpha = 1;

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gagal membuat strip."))),
      "image/png",
    );
  });
}
